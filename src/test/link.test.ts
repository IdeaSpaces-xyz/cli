import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const { loadConfigMock, fetchAuthMeMock, isInsideWorkTreeMock, originUrlMock, setLocalConfigMock, saveSpaceMock, findSpaceForMock } =
  vi.hoisted(() => ({
    loadConfigMock: vi.fn(),
    fetchAuthMeMock: vi.fn(),
    isInsideWorkTreeMock: vi.fn(),
    originUrlMock: vi.fn(),
    setLocalConfigMock: vi.fn(),
    saveSpaceMock: vi.fn(),
    findSpaceForMock: vi.fn(),
  }));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock };
});
// Partial mock: keep the real `normalizeRepoUrl` (URL matching must work), but
// stub the git-spawning helpers link actually calls.
vi.mock("../git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git.js")>();
  return { ...actual, isInsideWorkTree: isInsideWorkTreeMock, originUrl: originUrlMock, setLocalConfig: setLocalConfigMock };
});
vi.mock("../auth/spaces.js", () => ({ saveSpace: saveSpaceMock, findSpaceFor: findSpaceForMock }));

const { linkCommand } = await import("../commands/link.js");
const { normalizeRepoUrl } = await import("../git.js");
const { UnauthorizedError } = await import("../auth/api.js");

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
  isInsideWorkTreeMock.mockReset().mockReturnValue(true);
  originUrlMock.mockReset().mockReturnValue(NOTES_ORIGIN);
  setLocalConfigMock.mockReset();
  saveSpaceMock.mockReset();
  findSpaceForMock.mockReset();
  findSpaceForMock.mockReturnValue(null);
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
  it("keeps a fork's lineage when re-linking the same Space", async () => {
    // Re-linking to fix a mismatch must not cost the fork its source. Only
    // `fork` writes these, and nothing can reconstruct them.
    findSpaceForMock.mockReturnValue({
      repo_id: "r1",
      slug: "notes",
      namespace: "alice",
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
    });

    expect(await linkCommand.run(["./theone"], {}, JSON_GLOBAL)).toBe(0);

    const written = saveSpaceMock.mock.calls.at(-1)?.[1];
    expect(written.source_root_node_id).toBe("n_ffffffffffffffffffffffff");
    expect(written.source_head).toBe("9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293");
    expect(written.repo_id).toBe("r1");
  });

  it("carries nothing across when the folder is re-pointed at another Space", async () => {
    // The dangerous shape: the old record names a different Space and holds a
    // root id the new one may not have. Carrying it forward would leave Space
    // A's root id under Space B's name — and the resolver's first rung trusts
    // a recorded root id without re-checking it, so the next `sync` would read
    // A's trail believing it is B's.
    findSpaceForMock.mockReturnValue({
      repo_id: "repo_other",
      slug: "elsewhere",
      namespace: "alice",
      root_node_id: "n_aaaaaaaaaaaaaaaaaaaaaaaa",
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "9f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293",
    });

    expect(await linkCommand.run(["./theone"], {}, JSON_GLOBAL)).toBe(0);

    const written = saveSpaceMock.mock.calls.at(-1)?.[1];
    expect(written.repo_id).toBe("r1");
    // No field of the previous Space survives — not its root id…
    expect(written.root_node_id).toBeUndefined();
    // …and not a lineage that described a clone of something else.
    expect(written.source_root_node_id).toBeUndefined();
    expect(written.source_head).toBeUndefined();
  });

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

  it.each([
    "https://git.example.test/spaces/n_0123456789abcdef01234567.git",
    "https://git.example.test/alice/notes.git",
  ])("matches canonical and compatibility origins after root migration: %s", async (origin) => {
    fetchAuthMeMock.mockResolvedValue({
      ...ALICE,
      repos: [
        {
          ...ALICE.repos[0],
          root_node_id: "n_0123456789abcdef01234567",
          route_status: "resolved",
          route_namespace: "alice",
          route_slug: "notes",
          canonical_path: "/spaces/n_0123456789abcdef01234567",
        },
      ],
    });
    originUrlMock.mockReturnValue(origin);

    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalledWith(expect.stringContaining("theone"), {
      repo_id: "r1",
      root_node_id: "n_0123456789abcdef01234567",
      slug: "notes",
      namespace: "alice",
      route_status: "resolved",
      route_namespace: "alice",
      route_slug: "notes",
      canonical_path: "/spaces/n_0123456789abcdef01234567",
    });
  });

  it("matches scp-style and .git-less origins through normalization", async () => {
    originUrlMock.mockReturnValue("git@git.example.test:alice/notes");
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalled();
  });

  it("re-links a folder by overwriting its registry binding (no --force)", async () => {
    // Re-binding a verified clone is intentionally idempotent — saveSpace is
    // replace-semantics and the binding is a pointer, not user content, so
    // there's nothing to destroy. (Verification still gates every bind.)
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalledWith(expect.stringContaining("theone"), {
      repo_id: "r1",
      slug: "notes",
      namespace: "alice",
    });
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

  it("refuses an ambiguous named space (same slug across repos)", async () => {
    fetchAuthMeMock.mockResolvedValue({
      ...ALICE,
      repos: [
        { repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 },
        { repo_id: "r2", slug: "notes", hostname: "acme.com", role: "member", member_count: 3 },
      ],
    });
    const code = await linkCommand.run(["./theone", "notes"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("ambiguous");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });
});

describe("link — identity wiring", () => {
  it("binds without wiring identity when the account has no username", async () => {
    // An org space (hostname namespace) resolves without a username, but the
    // `person:<username>` identity can't be formed — wiring is skipped, not fatal.
    originUrlMock.mockReturnValue("https://git.example.test/acme.com/team.git");
    fetchAuthMeMock.mockResolvedValue({
      username: null,
      name: null,
      repos: [{ repo_id: "r9", slug: "team", hostname: "acme.com", role: "member", member_count: 2 }],
    });
    const code = await linkCommand.run(["./team"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalled();
    expect(setLocalConfigMock).not.toHaveBeenCalled();
  });

  it("still succeeds when wiring the identity throws", async () => {
    setLocalConfigMock.mockImplementation(() => {
      throw new Error("config locked");
    });
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);
    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalled();
  });
});

describe("link — guards", () => {
  it("refuses a non-git folder", async () => {
    isInsideWorkTreeMock.mockReturnValue(false);
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

  it("refuses an unparseable origin URL", async () => {
    originUrlMock.mockReturnValue("not-a-url");
    const code = await linkCommand.run(["./weird"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Could not parse the origin remote");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("errors on session expiry (UnauthorizedError)", async () => {
    fetchAuthMeMock.mockRejectedValue(new UnauthorizedError("session expired"));
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("Session expired");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });

  it("reports a registry write failure after the folder verifies", async () => {
    saveSpaceMock.mockImplementation(() => {
      throw new Error("disk full");
    });
    const code = await linkCommand.run(["./theone"], {}, JSON_GLOBAL);
    expect(code).toBe(1);
    expect(stderr()).toContain("could not write the clone registry");
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
