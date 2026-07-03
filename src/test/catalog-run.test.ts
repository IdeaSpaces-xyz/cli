import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchAuthMeMock, listClonesMock, gitStateMock, gitFetchMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchAuthMeMock: vi.fn(),
  listClonesMock: vi.fn(),
  gitStateMock: vi.fn(),
  gitFetchMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock };
});
vi.mock("../auth/spaces.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/spaces.js")>();
  return { ...actual, listClones: listClonesMock };
});
vi.mock("@ideaspaces/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ideaspaces/sdk")>();
  return { ...actual, gitState: gitStateMock };
});
vi.mock("../git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git.js")>();
  return { ...actual, fetch: gitFetchMock };
});

const { catalogCommand } = await import("../commands/catalog.js");
const { UnauthorizedError } = await import("../auth/api.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  (process.stderr.write as unknown as (s: string) => boolean) = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
  gitStateMock.mockResolvedValue({ branch: "main", ahead: 0, behind: 0, dirty: false });
  gitFetchMock.mockReturnValue(undefined);
});

afterEach(() => {
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
  (process.stderr.write as unknown as typeof originalErr) = originalErr;
  loadConfigMock.mockReset();
  fetchAuthMeMock.mockReset();
  listClonesMock.mockReset();
  gitStateMock.mockReset();
  gitFetchMock.mockReset();
});

const stdout = () => stdoutChunks.join("");

describe("catalog — command run()", () => {
  it("logged out → local clones only, all available, with a login note", async () => {
    loadConfigMock.mockReturnValue(null);
    listClonesMock.mockReturnValue([{ path: "/w/notes", record: { repo_id: "r1", slug: "notes", namespace: "alice" } }]);

    const code = await catalogCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const data = JSON.parse(stdout());
    expect(data.logged_in).toBe(false);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({ slug: "notes", location: "available" });
    expect(data.notes.join(" ")).toContain("Not logged in");
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
  });

  it("logged in → joins server + clones with sync state", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [
        { repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 },
        { repo_id: "r2", slug: "team", hostname: "acme.com", role: "member", member_count: 3 },
      ],
    });
    listClonesMock.mockReturnValue([{ path: "/w/notes", record: { repo_id: "r1", slug: "notes", namespace: "alice" } }]);
    gitStateMock.mockResolvedValue({ branch: "main", ahead: 0, behind: 2, dirty: true });

    const code = await catalogCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const data = JSON.parse(stdout());
    expect(data.logged_in).toBe(true);
    const by = Object.fromEntries(data.entries.map((e: { slug: string }) => [e.slug, e]));
    expect(by.notes).toMatchObject({ location: "available", sync: { behind: 2, dirty: true } });
    expect(by.team).toMatchObject({ location: "online-only", namespace: "acme.com" });
  });

  it("session-expired → degrades to the local tier with a note", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.test", apiKey: "k" });
    fetchAuthMeMock.mockRejectedValue(new UnauthorizedError("401"));
    listClonesMock.mockReturnValue([{ path: "/w/notes", record: { repo_id: "r1", slug: "notes", namespace: "alice" } }]);

    const code = await catalogCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const data = JSON.parse(stdout());
    expect(data.logged_in).toBe(false);
    expect(data.entries[0]).toMatchObject({ location: "available" });
    expect(data.notes.join(" ")).toContain("Session expired");
  });

  it("--fetch failures add a staleness note but never fail the catalog", async () => {
    loadConfigMock.mockReturnValue(null);
    listClonesMock.mockReturnValue([
      { path: "/w/a", record: { repo_id: "ra", slug: "a", namespace: "alice" } },
      { path: "/w/b", record: { repo_id: "rb", slug: "b", namespace: "alice" } },
    ]);
    gitFetchMock.mockImplementation((cwd: string) => {
      if (cwd === "/w/a") throw new Error("no network");
    });

    const code = await catalogCommand.run([], { fetch: true }, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(gitFetchMock).toHaveBeenCalledTimes(2);
    const data = JSON.parse(stdout());
    expect(data.notes.join(" ")).toContain("1 of 2 clone(s) could not be fetched");
  });
});
