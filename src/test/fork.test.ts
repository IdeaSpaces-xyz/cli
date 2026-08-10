import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const {
  loadConfigMock,
  fetchAuthMeMock,
  getSpaceMock,
  copySpaceMock,
  cloneRepoMock,
  saveSpaceMock,
  registerHelperMock,
  setLocalConfigMock,
  commitPathsMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchAuthMeMock: vi.fn(),
  getSpaceMock: vi.fn(),
  copySpaceMock: vi.fn(),
  cloneRepoMock: vi.fn(),
  saveSpaceMock: vi.fn(),
  registerHelperMock: vi.fn(),
  setLocalConfigMock: vi.fn(),
  commitPathsMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadConfig: loadConfigMock }));
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    fetchAuthMe: fetchAuthMeMock,
    getSpace: getSpaceMock,
    copySpace: copySpaceMock,
  };
});
vi.mock("../git.js", () => ({
  cloneRepo: cloneRepoMock,
  setLocalConfig: setLocalConfigMock,
  commitPaths: commitPathsMock,
}));
vi.mock("../auth/spaces.js", () => ({ saveSpace: saveSpaceMock }));
vi.mock("../auth/git-credential-helper.js", () => ({ registerGitCredentialHelper: registerHelperMock }));

const { forkCommand } = await import("../commands/fork.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const SOURCE_ROOT = "n_0123456789abcdef01234567";
const DEST_ROOT = "n_89abcdef0123456701234567";
const SOURCE_URL = `https://example.test/spaces/${SOURCE_ROOT}`;

let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;
// The clone mock now materializes the destination, so each test needs its own
// root: fork refuses a directory that already exists, and a leftover from a
// previous run would make these fail for the wrong reason.
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "is-cli-fork-"));
  for (const mock of [
    loadConfigMock,
    fetchAuthMeMock,
    getSpaceMock,
    copySpaceMock,
    cloneRepoMock,
    saveSpaceMock,
    registerHelperMock,
    setLocalConfigMock,
    commitPathsMock,
  ]) {
    mock.mockReset();
  }
  // The real clone creates the destination; the ignore scaffold writes into it.
  cloneRepoMock.mockImplementation((_url: string, dir: string) => {
    mkdirSync(dir, { recursive: true });
  });
  loadConfigMock.mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
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
  rmSync(tmpRoot, { recursive: true, force: true });
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

function sourceResult(copyEnabled = true) {
  return {
    kind: "space",
    node_id: SOURCE_ROOT,
    container_node_id: SOURCE_ROOT,
    name: "Manual",
    canonical_url: `/spaces/${SOURCE_ROOT}`,
    copy_enabled: copyEnabled,
    login_required_to_copy: false,
    summary: null,
    readme_markdown: null,
  };
}

function copyResult() {
  return {
    repo_id: "repo_copy",
    root_node_id: DEST_ROOT,
    slug: "manual",
    name: "Manual",
    source_head: "abc123",
    markdown_file_count: 3,
    markdown_bytes: 120,
    indexed_files: 3,
    index_status: "fresh",
    last_index_error: null,
  };
}

describe("fork", () => {
  it("creates a clean copy, clones its root endpoint, and stores route metadata", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockResolvedValueOnce({
        username: "alice",
        repos: [
          {
            repo_id: "repo_copy",
            root_node_id: DEST_ROOT,
            slug: "manual",
            hostname: "acme.com",
            role: "OWNER",
            member_count: 1,
            route_status: "resolved",
            route_namespace: "acme.com",
            route_slug: "manual",
            canonical_path: `/spaces/${DEST_ROOT}`,
          },
        ],
      });
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());

    const dir = join(tmpRoot, "success");
    const code = await forkCommand.run(
      [SOURCE_URL, dir],
      { location: "acme.com" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(copySpaceMock).toHaveBeenCalledWith(
      { apiUrl: "https://api.example.test", apiKey: "k" },
      SOURCE_ROOT,
      { name: "Manual", hostname: "acme.com" },
      { timeoutMs: 120_000 },
    );
    expect(cloneRepoMock).toHaveBeenCalledWith(
      `https://git.example.test/spaces/${DEST_ROOT}.git`,
      dir,
    );
    expect(saveSpaceMock).toHaveBeenCalledWith(dir, {
      repo_id: "repo_copy",
      root_node_id: DEST_ROOT,
      slug: "manual",
      namespace: "acme.com",
      route_status: "resolved",
      route_namespace: "acme.com",
      route_slug: "manual",
      canonical_path: `/spaces/${DEST_ROOT}`,
      source_root_node_id: SOURCE_ROOT,
      source_head: "abc123",
    });
    expect(JSON.parse(stdout())).toMatchObject({
      source_root_node_id: SOURCE_ROOT,
      source_head: "abc123",
      root_node_id: DEST_ROOT,
      space_url: `https://example.test/spaces/${DEST_ROOT}`,
      source_history_copied: false,
    });
  });

  it("writes and commits ignore rules into the clone the copy could not carry", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockResolvedValueOnce({ username: "alice", repos: [] });
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());

    const dir = join(tmpRoot, "ignored");
    const code = await forkCommand.run([SOURCE_URL, dir], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const written = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(written).toContain("*.local.md");
    expect(commitPathsMock).toHaveBeenCalledWith(
      "Ignore local-only files",
      [".gitignore"],
      dir,
    );
    // Identity is wired before the ignore commit — it becomes the clone's tip,
    // and publish's pre-receive check reads the tip author.
    expect(setLocalConfigMock.mock.invocationCallOrder[0]).toBeLessThan(
      commitPathsMock.mock.invocationCallOrder[0],
    );
    expect(JSON.parse(stdout()).ignore_rules_active).toBe(true);
  });

  it("leaves a copy that already carries the defaults alone", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockResolvedValueOnce({ username: "alice", repos: [] });
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());
    // A copy that one day carries more than markdown; today it never does.
    const carried = "node_modules/\n\n# ideaspace defaults\n*.local.md\n";
    cloneRepoMock.mockImplementation((_url: string, target: string) => {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, ".gitignore"), carried);
    });

    const dir = join(tmpRoot, "already-ignored");
    const code = await forkCommand.run([SOURCE_URL, dir], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    // Already protected: nothing rewritten, nothing committed, and the answer
    // is still that local-only files are ignored here.
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toBe(carried);
    expect(commitPathsMock).not.toHaveBeenCalled();
    expect(JSON.parse(stdout()).ignore_rules_active).toBe(true);
  });

  it("says so on every surface when the rules could not be written at all", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockResolvedValueOnce({ username: "alice", repos: [] });
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());
    // Clone into a path the scaffold cannot write: the destination is a file.
    cloneRepoMock.mockImplementation((_url: string, target: string) => {
      mkdirSync(join(target, ".gitignore"), { recursive: true });
    });

    const dir = join(tmpRoot, "unwritable");
    // --quiet, no --json: the surface where a suppressed log would be the only
    // signal that nothing in this clone is ignored.
    const code = await forkCommand.run(
      [SOURCE_URL, dir],
      {},
      { json: false, quiet: true, yes: false, help: false },
    );

    expect(code).toBe(0);
    expect(stderr()).toContain("unprotected");
    expect(stdout()).toContain("NOT ignored");
  });

  it("keeps the fork when its ignore rules cannot be committed", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockResolvedValueOnce({ username: "alice", repos: [] });
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());
    commitPathsMock.mockImplementation(() => {
      throw new Error("no identity configured");
    });

    const dir = join(tmpRoot, "commit-fails");
    const code = await forkCommand.run([SOURCE_URL, dir], {}, JSON_GLOBAL);

    // The fork already happened on the server — a failed ignore commit does not
    // fail the command, and the rules it wrote are already in force: git reads
    // .gitignore from the working tree, committed or not.
    expect(code).toBe(0);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain("*.local.md");
    expect(JSON.parse(stdout()).ignore_rules_active).toBe(true);
    expect(stderr()).toContain("commit `.gitignore`");
  });

  it("records lineage on the fallback record when route metadata is unavailable", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockRejectedValueOnce(new Error("refresh failed"));
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());

    const dir = join(tmpRoot, "fallback");
    const code = await forkCommand.run([SOURCE_URL, dir], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(saveSpaceMock).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({
        source_root_node_id: SOURCE_ROOT,
        source_head: "abc123",
        route_status: "unavailable",
      }),
    );
  });

  it("leaves the pin unset when the server reports no source head", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockResolvedValueOnce({ username: "alice", repos: [] });
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue({ ...copyResult(), source_head: "  " });

    const dir = join(tmpRoot, "nohead");
    const code = await forkCommand.run([SOURCE_URL, dir], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    const record = saveSpaceMock.mock.calls.at(-1)?.[1];
    expect(record.source_root_node_id).toBe(SOURCE_ROOT);
    // Absent, not blank — an update path must be able to tell "no pin" from a
    // pin that is not a commit.
    expect(record).not.toHaveProperty("source_head");
    expect(JSON.parse(stdout()).source_head).toBeNull();
  });

  it("rejects an unconfigured source URL before any source request", async () => {
    const code = await forkCommand.run(
      [`https://evil.test/spaces/${SOURCE_ROOT}`],
      {},
      JSON_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain("configured host");
    expect(fetchAuthMeMock).not.toHaveBeenCalled();
    expect(getSpaceMock).not.toHaveBeenCalled();
    expect(copySpaceMock).not.toHaveBeenCalled();
  });

  it("rejects an existing explicit destination before creating a remote copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "is-cli-fork-existing-"));
    try {
      const code = await forkCommand.run([SOURCE_URL, dir], {}, JSON_GLOBAL);

      expect(code).toBe(1);
      expect(stderr()).toContain("already exists");
      expect(fetchAuthMeMock).not.toHaveBeenCalled();
      expect(copySpaceMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the committed Space when its derived destination collides", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "is-cli-fork-derived-"));
    mkdirSync(join(cwd, "manual"));
    try {
      process.chdir(cwd);
      fetchAuthMeMock.mockResolvedValue({ username: "alice", repos: [] });
      getSpaceMock.mockResolvedValue(sourceResult());
      copySpaceMock.mockResolvedValue(copyResult());

      const code = await forkCommand.run([SOURCE_URL], {}, JSON_GLOBAL);

      expect(code).toBe(1);
      expect(copySpaceMock).toHaveBeenCalled();
      expect(stderr()).toContain(`Fork created at https://example.test/spaces/${DEST_ROOT}`);
      expect(stderr()).toContain("already exists");
      expect(cloneRepoMock).not.toHaveBeenCalled();
    } finally {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each(["location", "name", "slug"])(
    "rejects bare --%s before network or mutation",
    async (flag) => {
      const code = await forkCommand.run([SOURCE_URL], { [flag]: true }, JSON_GLOBAL);

      expect(code).toBe(1);
      expect(stderr()).toContain("require values");
      expect(fetchAuthMeMock).not.toHaveBeenCalled();
      expect(copySpaceMock).not.toHaveBeenCalled();
    },
  );

  it("does not copy when the source policy denies it", async () => {
    fetchAuthMeMock.mockResolvedValue({ username: "alice", repos: [] });
    getSpaceMock.mockResolvedValue(sourceResult(false));

    const code = await forkCommand.run([SOURCE_URL], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("does not allow");
    expect(copySpaceMock).not.toHaveBeenCalled();
  });

  it("reports committed destination identity when local clone fails", async () => {
    fetchAuthMeMock.mockResolvedValue({ username: "alice", repos: [] });
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());
    cloneRepoMock.mockImplementation(() => {
      throw new Error("network down");
    });

    const code = await forkCommand.run(
      [SOURCE_URL, join(tmpRoot, "failure")],
      {},
      JSON_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain(`Fork created at https://example.test/spaces/${DEST_ROOT}`);
    expect(stderr()).toContain("do not repeat fork");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });
});
