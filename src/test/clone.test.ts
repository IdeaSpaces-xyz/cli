import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchAuthMeMock, cloneRepoMock, saveSpaceMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchAuthMeMock: vi.fn(),
  cloneRepoMock: vi.fn(),
  saveSpaceMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock };
});
vi.mock("../git.js", () => ({ cloneRepo: cloneRepoMock }));
vi.mock("../auth/spaces.js", () => ({ saveSpace: saveSpaceMock }));

const { cloneCommand } = await import("../commands/clone.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

beforeEach(() => {
  loadConfigMock.mockReset();
  fetchAuthMeMock.mockReset();
  cloneRepoMock.mockReset();
  saveSpaceMock.mockReset();
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
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

describe("clone", () => {
  it("resolves a space by slug, clones, and binds the folder", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [{ repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 }],
    });

    const code = await cloneCommand.run(["notes"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(cloneRepoMock).toHaveBeenCalledWith(
      expect.stringContaining("/alice/notes.git"),
      expect.stringContaining("notes"),
    );
    expect(saveSpaceMock).toHaveBeenCalledWith(expect.stringContaining("notes"), {
      repo_id: "r1",
      slug: "notes",
      namespace: "alice",
    });
    expect(JSON.parse(stdout())).toMatchObject({ repo_id: "r1", slug: "notes", namespace: "alice" });
  });

  it("resolves an org space namespace from its hostname", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [{ repo_id: "r2", slug: "team", hostname: "acme.com", role: "member", member_count: 4 }],
    });

    const code = await cloneCommand.run(["team"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(cloneRepoMock).toHaveBeenCalledWith(
      expect.stringContaining("/acme.com/team.git"),
      expect.anything(),
    );
  });

  it("errors and does not clone when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);

    const code = await cloneCommand.run(["notes"], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
    expect(cloneRepoMock).not.toHaveBeenCalled();
  });

  it("errors when no space matches", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({ username: "alice", repos: [] });

    const code = await cloneCommand.run(["nope"], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("No space matches");
  });

  it("requires a target argument", async () => {
    const code = await cloneCommand.run([], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
  });
});
