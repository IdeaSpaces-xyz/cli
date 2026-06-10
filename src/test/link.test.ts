import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchAuthMeMock, isGitRepoMock, originUrlMock, setLocalConfigMock, saveSpaceMock } =
  vi.hoisted(() => ({
    loadConfigMock: vi.fn(),
    fetchAuthMeMock: vi.fn(),
    isGitRepoMock: vi.fn(),
    originUrlMock: vi.fn(),
    setLocalConfigMock: vi.fn(),
    saveSpaceMock: vi.fn(),
  }));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock };
});
vi.mock("../git.js", () => ({
  isGitRepo: isGitRepoMock,
  originUrl: originUrlMock,
  setLocalConfig: setLocalConfigMock,
}));
vi.mock("../auth/spaces.js", () => ({ saveSpace: saveSpaceMock }));

const { linkCommand } = await import("../commands/link.js");
const { normalizeRepoUrl } = await import("../auth/api.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

// Origin URL for alice's `notes` space under the test api host.
const NOTES_ORIGIN = "https://git.example.test/alice/notes.git";
const ALICE = {
  username: "alice",
  name: "Alice Smith",
  repos: [{ repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 }],
};

beforeEach(() => {
  loadConfigMock.mockReset().mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
  fetchAuthMeMock.mockReset().mockResolvedValue(ALICE);
  isGitRepoMock.mockReset().mockReturnValue(true);
  originUrlMock.mockReset().mockReturnValue(NOTES_ORIGIN);
  setLocalConfigMock.mockReset();
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

describe("normalizeRepoUrl", () => {
  it("canonicalizes equivalent URL forms to the same key", () => {
    const key = "git.example.test/alice/notes";
    expect(normalizeRepoUrl("https://git.example.test/alice/notes.git")).toBe(key);
    expect(normalizeRepoUrl("https://git.example.test/alice/notes")).toBe(key);
    expect(normalizeRepoUrl("https://git.example.test/alice/notes/")).toBe(key);
    expect(normalizeRepoUrl("https://bob:pat@git.example.test/alice/notes.git")).toBe(key);
    expect(normalizeRepoUrl("git@git.example.test:alice/notes.git")).toBe(key);
    expect(normalizeRepoUrl("ssh://git@GIT.EXAMPLE.TEST/alice/notes.git")).toBe(key);
  });

  it("keeps the path case-sensitive and rejects junk", () => {
    expect(normalizeRepoUrl("https://git.example.test/Alice/Notes.git")).toBe("git.example.test/Alice/Notes");
    expect(normalizeRepoUrl("")).toBeNull();
    expect(normalizeRepoUrl("not a url")).toBeNull();
  });
});

describe("link — auto-detect from origin", () => {
  it("binds the folder when the origin matches exactly one space", async () => {
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalledWith(expect.stringContaining("theone"), {
      repo_id: "r1",
      slug: "notes",
      namespace: "alice",
    });
    // Identity wired so commits here pass the attribution hook.
    expect(setLocalConfigMock).toHaveBeenCalledWith("user.email", "person:alice@ideaspaces", expect.any(String));
    expect(setLocalConfigMock).toHaveBeenCalledWith("user.name", "Alice Smith", expect.any(String));
    expect(JSON.parse(stdout())).toMatchObject({ repo_id: "r1", slug: "notes", namespace: "alice" });
  });

  it("matches scp-style and .git-less origins through normalization", async () => {
    originUrlMock.mockReturnValue("git@git.example.test:alice/notes");
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalled();
  });

  it("rejects a folder whose origin isn't one of the user's spaces", async () => {
    originUrlMock.mockReturnValue("https://github.com/someone/else.git");
    const code = await linkCommand.run(["./elsewhere"], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("isn't a clone of one of your spaces");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });
});

describe("link — explicit target", () => {
  it("binds when the origin matches the named space", async () => {
    const code = await linkCommand.run(["./theone", "alice/notes"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalled();
  });

  it("rejects when the origin doesn't match the named space", async () => {
    fetchAuthMeMock.mockResolvedValue({
      ...ALICE,
      repos: [
        { repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 },
        { repo_id: "r2", slug: "other", hostname: null, role: "owner", member_count: 1 },
      ],
    });
    const code = await linkCommand.run(["./theone", "alice/other"], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("doesn't match");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("errors when the named space doesn't exist", async () => {
    const code = await linkCommand.run(["./theone", "nope"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("No space matches");
  });
});

describe("link — guards", () => {
  it("refuses a non-git folder", async () => {
    isGitRepoMock.mockReturnValue(false);
    const code = await linkCommand.run(["./plain"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("not a git repository");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("refuses a repo with no origin remote", async () => {
    originUrlMock.mockReturnValue(null);
    const code = await linkCommand.run(["./local-only"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("no `origin`");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("errors when not logged in", async () => {
    loadConfigMock.mockReturnValue(null);
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Not logged in");
  });

  it("requires a directory argument", async () => {
    const code = await linkCommand.run([], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Usage");
  });
});
