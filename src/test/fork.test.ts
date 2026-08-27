import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSpaceFor } from "../auth/spaces.js";
import { loadForkBaseline } from "../fork-update.js";
import type { GlobalFlags } from "../types.js";

const { loadOptionalAuthConfigMock, getSpaceMock, getSpaceCopySnapshotMock } = vi.hoisted(() => ({
  loadOptionalAuthConfigMock: vi.fn(),
  getSpaceMock: vi.fn(),
  getSpaceCopySnapshotMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/credentials.js")>();
  return { ...actual, loadOptionalAuthConfig: loadOptionalAuthConfigMock };
});
vi.mock("../auth/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/api.js")>();
  return {
    ...actual,
    getSpace: getSpaceMock,
    getSpaceCopySnapshot: getSpaceCopySnapshotMock,
  };
});

const { UnauthorizedError } = await import("../auth/api.js");
const { forkCommand } = await import("../commands/fork.js");

const JSON_GLOBAL: GlobalFlags = { json: true, quiet: false, yes: false, help: false };
const SOURCE_ROOT = "n_0123456789abcdef01234567";
const SOURCE_URL = `https://example.test/spaces/${SOURCE_ROOT}`;
const HEAD = "a".repeat(40);

let root: string;
let home: string;
let work: string;
let originalHome: string | undefined;
let stdoutChunks: string[];
let stderrChunks: string[];
let originalOut: typeof process.stdout.write;
let originalErr: typeof process.stderr.write;

function md(nodeId: string, body: string, extra = ""): string {
  return `---\nnode_id: ${nodeId}\n${extra}---\n${body}\n`;
}

function sourceResult(copyEnabled = true) {
  return {
    kind: "space",
    node_id: SOURCE_ROOT,
    container_node_id: SOURCE_ROOT,
    name: "Public Guide",
    canonical_url: `/spaces/${SOURCE_ROOT}`,
    copy_enabled: copyEnabled,
    login_required_to_copy: true,
    summary: null,
    readme_markdown: null,
  };
}

function snapshotResult(overrides: Record<string, unknown> = {}) {
  const files = [
    {
      path: "_agent/foundation.md",
      content: md("n_111111111111111111111111", "# Foundation"),
    },
    {
      path: "README.md",
      content: md(
        "n_222222222222222222222222",
        "See node:n_111111111111111111111111",
      ),
    },
  ];
  return {
    source_head: HEAD,
    markdown_file_count: files.length,
    markdown_bytes: files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    files,
    asset_file_count: 1,
    asset_bytes: 7,
    assets: [{ path: "_assets/picture.png", content_base64: "cGF5bG9hZA==" }],
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function foundationMetadata(destination: string): Record<string, unknown> {
  const content = readFileSync(join(destination, "_agent", "foundation.md"), "utf-8");
  const end = content.indexOf("\n---\n", 4);
  return parse(content.slice(4, end)) as Record<string, unknown>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "is-cli-local-fork-"));
  home = join(root, "home");
  work = join(root, "work");
  mkdirSync(home);
  mkdirSync(work);
  originalHome = process.env.HOME;
  process.env.HOME = home;
  loadOptionalAuthConfigMock.mockReset();
  getSpaceMock.mockReset();
  getSpaceCopySnapshotMock.mockReset();
  loadOptionalAuthConfigMock.mockReturnValue({ apiUrl: "https://api.example.test" });
  getSpaceMock.mockResolvedValue(sourceResult());
  getSpaceCopySnapshotMock.mockResolvedValue(snapshotResult());

  stdoutChunks = [];
  stderrChunks = [];
  originalOut = process.stdout.write.bind(process.stdout);
  originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
});

const stdout = () => stdoutChunks.join("");
const stderr = () => stderrChunks.join("");

describe("account-free local fork", () => {
  it("materializes one clean local main repo with fresh identity, lineage, baseline, and assets", async () => {
    const destination = join(work, "guide");
    const code = await forkCommand.run([SOURCE_URL, destination], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(getSpaceMock).toHaveBeenCalledWith(
      { apiUrl: "https://api.example.test" },
      SOURCE_ROOT,
      { timeoutMs: 120_000 },
    );
    expect(getSpaceCopySnapshotMock).toHaveBeenCalledWith(
      { apiUrl: "https://api.example.test" },
      SOURCE_ROOT,
      { timeoutMs: 120_000 },
    );
    expect(readFileSync(join(destination, "_assets", "picture.png"))).toEqual(
      Buffer.from("payload"),
    );
    expect(readFileSync(join(destination, ".gitignore"), "utf-8")).toContain("*.local.md");
    expect(git(destination, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(destination, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(destination, "status", "--porcelain")).toBe("");
    expect(git(destination, "remote")).toBe("");
    expect(git(destination, "log", "-1", "--format=%ae")).toBe("import@ideaspaces");

    const metadata = foundationMetadata(destination);
    expect(metadata.root_node_id).toMatch(/^n_[0-9a-f]{24}$/);
    expect(metadata.root_node_id).not.toBe(SOURCE_ROOT);
    const record = findSpaceFor(destination);
    expect(record).toEqual({
      kind: "unpublished_fork",
      root_node_id: metadata.root_node_id,
      name: "Public Guide",
      source_root_node_id: SOURCE_ROOT,
      source_head: HEAD,
      source_baseline_initialized: true,
    });
    expect(loadForkBaseline(destination)).toMatchObject({
      source_root_node_id: SOURCE_ROOT,
      source_head: HEAD,
      files: { "_agent/foundation.md": expect.stringContaining(String(metadata.root_node_id)) },
      conflicts: [],
    });

    const result = JSON.parse(stdout());
    expect(result).toMatchObject({
      kind: "unpublished_fork",
      root_node_id: metadata.root_node_id,
      source_root_node_id: SOURCE_ROOT,
      source_head: HEAD,
      source_history_copied: false,
      published: false,
      asset_file_count: 1,
    });
    for (const hostedField of ["repo_id", "slug", "namespace", "remote_url", "space_url"]) {
      expect(result).not.toHaveProperty(hostedField);
    }
  });

  it("ignores ambient Git repository, identity, and command-config overrides", async () => {
    const destination = join(work, "sanitized");
    const keys = [
      "GIT_DIR",
      "GIT_AUTHOR_EMAIL",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.GIT_DIR = join(root, "ambient-git-dir");
    process.env.GIT_AUTHOR_EMAIL = "ambient@example.test";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    let code: number | void = undefined;
    try {
      code = await forkCommand.run([SOURCE_URL, destination], {}, JSON_GLOBAL);
    } finally {
      for (const key of keys) {
        const value = before[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(code).toBe(0);
    expect(git(destination, "log", "-1", "--format=%ae")).toBe("import@ideaspaces");
    expect(existsSync(join(root, "ambient-git-dir"))).toBe(false);
  });

  it("uses valid ambient credentials for a directly shared private source", async () => {
    const config = { apiUrl: "https://api.example.test", apiKey: "secret" };
    loadOptionalAuthConfigMock.mockReturnValue(config);
    const destination = join(work, "private");

    const code = await forkCommand.run([SOURCE_URL, destination], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(getSpaceMock.mock.calls[0][0]).toEqual(config);
    expect(getSpaceCopySnapshotMock.mock.calls[0][0]).toEqual(config);
  });

  it("retries stale ambient credentials anonymously for a public source", async () => {
    loadOptionalAuthConfigMock.mockReturnValue({
      apiUrl: "https://api.example.test",
      apiKey: "expired",
    });
    getSpaceMock
      .mockRejectedValueOnce(new UnauthorizedError("expired"))
      .mockResolvedValueOnce(sourceResult());
    const destination = join(work, "fallback");

    const code = await forkCommand.run([SOURCE_URL, destination], {}, JSON_GLOBAL);

    expect(code).toBe(0);
    expect(getSpaceMock.mock.calls.map((call) => call[0])).toEqual([
      { apiUrl: "https://api.example.test", apiKey: "expired" },
      { apiUrl: "https://api.example.test" },
    ]);
    expect(getSpaceCopySnapshotMock.mock.calls[0][0]).toEqual({
      apiUrl: "https://api.example.test",
    });
  });

  it.each(["location", "slug"])(
    "retires --%s before network or path creation",
    async (flag) => {
      const destination = join(work, `retired-${flag}`);
      const code = await forkCommand.run(
        [SOURCE_URL, destination],
        { [flag]: "old-value" },
        JSON_GLOBAL,
      );

      expect(code).toBe(1);
      expect(stderr()).toContain("local-only");
      expect(stderr()).toContain("ideaspaces publish");
      expect(getSpaceMock).not.toHaveBeenCalled();
      expect(existsSync(destination)).toBe(false);
    },
  );

  it("uses --name only as local display state", async () => {
    const destination = join(work, "named");
    const code = await forkCommand.run(
      [SOURCE_URL, destination],
      { name: "My local guide" },
      JSON_GLOBAL,
    );

    expect(code).toBe(0);
    expect(findSpaceFor(destination)).toMatchObject({ name: "My local guide" });
    expect(getSpaceCopySnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("leaves no destination or temporary sibling for denied and malformed sources", async () => {
    const denied = join(work, "denied");
    getSpaceMock.mockResolvedValueOnce(sourceResult(false));
    expect(await forkCommand.run([SOURCE_URL, denied], {}, JSON_GLOBAL)).toBe(1);
    expect(existsSync(denied)).toBe(false);

    const malformed = join(work, "malformed");
    getSpaceMock.mockResolvedValueOnce(sourceResult());
    getSpaceCopySnapshotMock.mockResolvedValueOnce(
      snapshotResult({ files: [{ path: "../escape.md", content: "bad" }], markdown_file_count: 1 }),
    );
    expect(await forkCommand.run([SOURCE_URL, malformed], {}, JSON_GLOBAL)).toBe(1);
    expect(existsSync(malformed)).toBe(false);
    expect(existsSync(join(work, "escape.md"))).toBe(false);
    expect(readdirSync(work).some((name) => name.startsWith(".malformed.ideaspaces-fork-"))).toBe(false);
    expect(existsSync(join(home, ".ideaspaces", "spaces.json"))).toBe(false);
  });

  it("rejects destination collisions before network access", async () => {
    const destination = join(work, "existing");
    mkdirSync(destination);

    const code = await forkCommand.run([SOURCE_URL, destination], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("already exists");
    expect(getSpaceMock).not.toHaveBeenCalled();
  });

  it("rolls back the installed repository when durable local state cannot be saved", async () => {
    const brokenHome = join(root, "home-is-a-file");
    writeFileSync(brokenHome, "not a directory");
    process.env.HOME = brokenHome;
    const destination = join(work, "rollback");

    const code = await forkCommand.run([SOURCE_URL, destination], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("no destination was kept");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(work).some((name) => name.startsWith(".rollback.ideaspaces-fork-"))).toBe(false);
  });

  it("refuses a projection without an existing root foundation", async () => {
    const destination = join(work, "foundationless");
    const files = [{ path: "README.md", content: md("n_222222222222222222222222", "Read") }];
    getSpaceCopySnapshotMock.mockResolvedValueOnce(
      snapshotResult({ files, markdown_file_count: 1 }),
    );

    const code = await forkCommand.run([SOURCE_URL, destination], {}, JSON_GLOBAL);

    expect(code).toBe(1);
    expect(stderr()).toContain("no root _agent/foundation.md");
    expect(existsSync(destination)).toBe(false);
  });
});
