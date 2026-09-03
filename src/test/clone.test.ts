import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GlobalFlags } from "../types.js";

const {
  loadConfigMock,
  fetchAuthMeMock,
  cloneRepoMock,
  saveSpaceMock,
  registerHelperMock,
  inspectRootIdentityMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchAuthMeMock: vi.fn(),
  cloneRepoMock: vi.fn(),
  saveSpaceMock: vi.fn(),
  registerHelperMock: vi.fn(),
  inspectRootIdentityMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return { ...actual, fetchAuthMe: fetchAuthMeMock };
});
vi.mock("../git.js", () => ({ cloneRepo: cloneRepoMock }));
vi.mock("../auth/spaces.js", () => ({ saveSpace: saveSpaceMock }));
vi.mock("../root-identity.js", () => ({ inspectLocalRootIdentity: inspectRootIdentityMock }));
// Stub the credential-helper self-heal so the test doesn't run real
// `git config --global` against the developer's ~/.gitconfig.
vi.mock("../auth/git-credential-helper.js", () => ({ registerGitCredentialHelper: registerHelperMock }));

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
  registerHelperMock.mockReset();
  inspectRootIdentityMock.mockReset();
  inspectRootIdentityMock.mockReturnValue({
    state: "absent",
    root_node_id: null,
    declaration: { head: null, index: null, worktree: null, dirty: false },
  });
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
  it("clones an exact Space URL through the root-addressed Git endpoint", async () => {
    const rootNodeId = "n_0123456789abcdef01234567";
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    inspectRootIdentityMock.mockReturnValue({
      state: "aligned",
      root_node_id: rootNodeId,
      declaration: { head: rootNodeId, index: rootNodeId, worktree: rootNodeId, dirty: false },
    });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      name: "Alice",
      repos: [
        {
          repo_id: "r1",
          root_node_id: rootNodeId,
          slug: "notes",
          hostname: null,
          role: "OWNER",
          member_count: 1,
          route_status: "resolved",
          route_namespace: "alice",
          route_slug: "notes",
          canonical_path: `/spaces/${rootNodeId}`,
        },
      ],
    });

    const code = await cloneCommand.run(
      [`https://example.test/spaces/${rootNodeId}`, "./local-notes"],
      {},
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(cloneRepoMock).toHaveBeenCalledWith(
      `https://git.example.test/spaces/${rootNodeId}.git`,
      expect.stringContaining("local-notes"),
    );
    expect(saveSpaceMock).toHaveBeenCalledWith(expect.stringContaining("local-notes"), {
      repo_id: "r1",
      root_node_id: rootNodeId,
      slug: "notes",
      namespace: "alice",
      route_status: "resolved",
      route_namespace: "alice",
      route_slug: "notes",
      canonical_path: `/spaces/${rootNodeId}`,
    });
    expect(JSON.parse(stdout())).toMatchObject({
      root_node_id: rootNodeId,
      space_url: `https://example.test/spaces/${rootNodeId}`,
      remote_url: `https://git.example.test/spaces/${rootNodeId}.git`,
    });
  });

  it("keeps a Copy-only receipt visible but refuses clone", async () => {
    const rootNodeId = "n_0123456789abcdef01234567";
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [
        {
          repo_id: "r1",
          root_node_id: rootNodeId,
          name: "Shared thoughts",
          receipt_classes: ["direct_person"],
          actions: ["copy"],
          route_status: "resolved",
          route_namespace: "alice",
          route_slug: "thoughts",
        },
      ],
    });

    const code = await cloneCommand.run(
      [`https://example.test/spaces/${rootNodeId}`],
      {},
      JSON_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("does not allow clone");
    expect(cloneRepoMock).not.toHaveBeenCalled();
  });

  it("rejects arbitrary URLs instead of handing them to Git", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({ username: "alice", repos: [] });

    const code = await cloneCommand.run(
      ["https://evil.test/spaces/n_0123456789abcdef01234567"],
      {},
      JSON_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("configured host");
    expect(cloneRepoMock).not.toHaveBeenCalled();
  });

  it("resolves a space by slug, clones, and binds the folder", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [{ repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 }],
    });

    const code = await cloneCommand.run(["notes"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    // The credential helper is (re-)registered before the network clone.
    expect(registerHelperMock).toHaveBeenCalled();
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

  it("resolves a space by namespace/slug", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [{ repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 }],
    });

    const code = await cloneCommand.run(["alice/notes"], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(cloneRepoMock).toHaveBeenCalledWith(
      expect.stringContaining("/alice/notes.git"),
      expect.anything(),
    );
  });

  it("refuses an ambiguous target", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [
        { repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 },
        { repo_id: "r2", slug: "notes", hostname: "acme.com", role: "member", member_count: 3 },
      ],
    });

    const code = await cloneCommand.run(["notes"], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("ambiguous");
    expect(cloneRepoMock).not.toHaveBeenCalled();
  });

  it("propagates a clone failure and does not bind", async () => {
    loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
    fetchAuthMeMock.mockResolvedValue({
      username: "alice",
      repos: [{ repo_id: "r1", slug: "notes", hostname: null, role: "owner", member_count: 1 }],
    });
    cloneRepoMock.mockImplementation(() => {
      throw new Error("destination path 'notes' already exists");
    });

    const code = await cloneCommand.run(["notes"], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("already exists");
    expect(saveSpaceMock).not.toHaveBeenCalled();
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
