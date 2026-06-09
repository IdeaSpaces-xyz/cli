import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchAuthMeMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchAuthMeMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock };
});

const { reposCommand } = await import("../commands/repos.js");
const { UnauthorizedError } = await import("../auth/api.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const HUMAN_GLOBAL: GlobalFlags = { json: false, quiet: false, yes: false, help: false };

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
});

afterEach(() => {
  (process.stdout.write as unknown as typeof originalOut) = originalOut;
  (process.stderr.write as unknown as typeof originalErr) = originalErr;
  loadConfigMock.mockReset();
  fetchAuthMeMock.mockReset();
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

describe("repos", () => {
  it("returns the user's spaces as JSON, with namespace resolved", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [
        { repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 },
        { repo_id: "r2", slug: "team", hostname: "acme.com", role: "member", member_count: 4 },
      ],
    });

    const code = await reposCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const data = JSON.parse(stdout());
    expect(data.username).toBe("alice");
    expect(data.repos[0]).toMatchObject({ slug: "notes", role: "owner", namespace: "alice" });
    expect(data.repos[1]).toMatchObject({ slug: "team", namespace: "acme.com" });
    expect(stdout()).not.toContain("\"apiKey\"");
  });

  it("errors when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);

    const code = await reposCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
  });

  it("maps a 401 to a session-expired message", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockRejectedValue(new UnauthorizedError("401"));

    const code = await reposCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("Session expired");
  });

  it("surfaces a generic error (non-401)", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockRejectedValue(new Error("GET /auth/me → 500: boom"));

    const code = await reposCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("500");
  });

  it("prints human-readable output with correct singular/plural", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [
        { repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 },
        { repo_id: "r2", slug: "team", hostname: "acme.com", role: "member", member_count: 4 },
      ],
    });

    const code = await reposCommand.run([], {}, HUMAN_GLOBAL);

    expect(code).toBe(0);
    expect(stdout()).toContain("notes (owner, 1 member)");
    expect(stdout()).toContain("team (member, 4 members)");
  });

  it("shows an empty-state hint when there are no spaces", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({ username: "alice", repos: [] });

    const code = await reposCommand.run([], {}, HUMAN_GLOBAL);

    expect(code).toBe(0);
    expect(stdout()).toContain("No spaces yet");
  });
});
