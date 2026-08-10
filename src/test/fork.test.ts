import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  fetchAuthMeMock: vi.fn(),
  getSpaceMock: vi.fn(),
  copySpaceMock: vi.fn(),
  cloneRepoMock: vi.fn(),
  saveSpaceMock: vi.fn(),
  registerHelperMock: vi.fn(),
  setLocalConfigMock: vi.fn(),
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
vi.mock("../git.js", () => ({ cloneRepo: cloneRepoMock, setLocalConfig: setLocalConfigMock }));
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

beforeEach(() => {
  for (const mock of [
    loadConfigMock,
    fetchAuthMeMock,
    getSpaceMock,
    copySpaceMock,
    cloneRepoMock,
    saveSpaceMock,
    registerHelperMock,
    setLocalConfigMock,
  ]) {
    mock.mockReset();
  }
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

    const dir = `/tmp/is-cli-fork-${process.pid}-success`;
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

  it("records lineage on the fallback record when route metadata is unavailable", async () => {
    fetchAuthMeMock
      .mockResolvedValueOnce({ username: "alice", name: "Alice", repos: [] })
      .mockRejectedValueOnce(new Error("refresh failed"));
    getSpaceMock.mockResolvedValue(sourceResult());
    copySpaceMock.mockResolvedValue(copyResult());

    const dir = `/tmp/is-cli-fork-${process.pid}-fallback`;
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

    const dir = `/tmp/is-cli-fork-${process.pid}-nohead`;
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
      [SOURCE_URL, `/tmp/is-cli-fork-${process.pid}-failure`],
      {},
      JSON_GLOBAL,
    );

    expect(code).toBe(1);
    expect(stderr()).toContain(`Fork created at https://example.test/spaces/${DEST_ROOT}`);
    expect(stderr()).toContain("do not repeat fork");
    expect(saveSpaceMock).not.toHaveBeenCalled();
  });
});
