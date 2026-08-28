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
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../types.js";

const { loadConfigMock, findSpaceForMock, saveSpaceMock, snapshotMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  findSpaceForMock: vi.fn(),
  saveSpaceMock: vi.fn(),
  snapshotMock: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => ({ loadOptionalAuthConfig: loadConfigMock }));
vi.mock("../auth/spaces.js", () => ({
  findSpaceFor: findSpaceForMock,
  saveSpace: saveSpaceMock,
}));
vi.mock("../auth/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/api.js")>()),
  getSpaceCopySnapshot: snapshotMock,
}));

const { updateCommand } = await import("../commands/update.js");
const SOURCE = "n_ffffffffffffffffffffffff";
const IDS = {
  changed: "n_aaaaaaaaaaaaaaaaaaaaaaaa",
  conflict: "n_bbbbbbbbbbbbbbbbbbbbbbbb",
  deleted: "n_cccccccccccccccccccccccc",
  guide: "n_dddddddddddddddddddddddd",
  added: "n_eeeeeeeeeeeeeeeeeeeeeeee",
};
const CANDIDATES = {
  changed: "n_111111111111111111111111",
  conflict: "n_222222222222222222222222",
  guide: "n_333333333333333333333333",
  added: "n_444444444444444444444444",
};
const GLOBAL: GlobalFlags = { json: true, quiet: false, yes: true, help: false };

function md(id: string, body: string): string {
  return `---\nnode_id: ${id}\n---\n${body}\n`;
}

let root: string;
let home: string;
let cwd: string;
let oldHome: string | undefined;
let oldOut: typeof process.stdout.write;
let oldErr: typeof process.stderr.write;
let errors: string[];

function write(path: string, content: string | Buffer): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "is-update-e2e-space-"));
  home = mkdtempSync(join(tmpdir(), "is-update-e2e-home-"));
  oldHome = process.env.HOME;
  process.env.HOME = home;
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  write("changed.md", md(IDS.changed, "old"));
  write("conflict.md", md(IDS.conflict, "old"));
  write("deleted.md", md(IDS.deleted, "delete"));
  write("_agent/guide.md", md(IDS.guide, "old guide"));
  write("_assets/changed.bin", Buffer.from([0, 1, 2]));
  write("_assets/conflict.bin", Buffer.from([3, 4, 5]));
  write("docs/_assets/deleted.bin", Buffer.from([6, 7]));
  write("bystander.txt", "before\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "copy"], { cwd: root });
  write("conflict.md", md(IDS.conflict, "local edit"));
  write("local.md", "ordinary local addition\n");
  write("progress.local.md", "private progress\n");
  write("_assets/conflict.bin", Buffer.from([9, 9, 9]));
  write("bystander.txt", "staged\n");
  execFileSync("git", ["add", "bystander.txt"], { cwd: root });

  cwd = process.cwd();
  process.chdir(root);
  oldOut = process.stdout.write.bind(process.stdout);
  oldErr = process.stderr.write.bind(process.stderr);
  errors = [];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((value: string | Uint8Array) => {
    errors.push(String(value));
    return true;
  }) as typeof process.stderr.write;

  loadConfigMock.mockReset().mockReturnValue({ apiUrl: "https://api.example.test", apiKey: "k" });
  findSpaceForMock.mockReset().mockReturnValue({
    repo_id: "repo_copy",
    slug: "guide",
    namespace: "alice",
    source_root_node_id: SOURCE,
    source_head: "a".repeat(40),
  });
  saveSpaceMock.mockReset();
  snapshotMock.mockReset().mockResolvedValue({
    source_head: "b".repeat(40),
    markdown_file_count: 4,
    markdown_bytes: 100,
    files: [
      { path: "changed.md", content: md(CANDIDATES.changed, "new") },
      { path: "conflict.md", content: md(CANDIDATES.conflict, "source edit") },
      { path: "_agent/guide.md", content: md(CANDIDATES.guide, "new guide") },
      { path: "added.md", content: md(CANDIDATES.added, "added") },
    ],
    asset_file_count: 3,
    asset_bytes: 8,
    assets: [
      { path: "_assets/changed.bin", content_base64: Buffer.from([2, 1, 0]).toString("base64") },
      { path: "_assets/conflict.bin", content_base64: Buffer.from([5, 4, 3]).toString("base64") },
      { path: "docs/_assets/added.bin", content_base64: Buffer.from([10, 11]).toString("base64") },
    ],
  });
});

afterEach(() => {
  process.stdout.write = oldOut;
  process.stderr.write = oldErr;
  process.chdir(cwd);
  process.env.HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("fork update acceptance", () => {
  it("applies B, preserves local work and bystanders, and makes the second run a no-op", async () => {
    const stagedBefore = execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: root,
      encoding: "utf-8",
    });
    const first = await updateCommand.run([], {}, GLOBAL);

    expect(first, errors.join("")).toBe(0);
    expect(readFileSync(join(root, "changed.md"), "utf-8")).toBe(md(IDS.changed, "new"));
    expect(readFileSync(join(root, "_agent/guide.md"), "utf-8")).toBe(
      md(IDS.guide, "new guide"),
    );
    expect(readFileSync(join(root, "added.md"), "utf-8")).toBe(md(CANDIDATES.added, "added"));
    expect(existsSync(join(root, "deleted.md"))).toBe(false);
    expect(readFileSync(join(root, "conflict.md"), "utf-8")).toBe(md(IDS.conflict, "local edit"));
    expect(readFileSync(join(root, "local.md"), "utf-8")).toBe("ordinary local addition\n");
    expect(readFileSync(join(root, "progress.local.md"), "utf-8")).toBe("private progress\n");
    expect(readFileSync(join(root, "_assets/changed.bin"))).toEqual(Buffer.from([2, 1, 0]));
    expect(readFileSync(join(root, "_assets/conflict.bin"))).toEqual(Buffer.from([9, 9, 9]));
    expect(readFileSync(join(root, "docs/_assets/added.bin"))).toEqual(Buffer.from([10, 11]));
    expect(existsSync(join(root, "docs/_assets/deleted.bin"))).toBe(false);
    expect(execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: root,
      encoding: "utf-8",
    })).toBe(stagedBefore);

    findSpaceForMock.mockReturnValue(saveSpaceMock.mock.calls[0][1]);
    const snapshot = Object.fromEntries(
      ["changed.md", "conflict.md", "_agent/guide.md", "added.md"].map((path) => [
        path,
        readFileSync(join(root, path), "utf-8"),
      ]),
    );
    const baselineDir = join(home, ".ideaspaces", "fork-baselines");
    const baselinePath = join(baselineDir, readdirSync(baselineDir)[0]);
    const baselineBefore = readFileSync(baselinePath);
    const registryWritesBefore = saveSpaceMock.mock.calls.length;
    const second = await updateCommand.run([], {}, GLOBAL);

    expect(second).toBe(0);
    for (const [path, content] of Object.entries(snapshot)) {
      expect(readFileSync(join(root, path), "utf-8")).toBe(content);
    }
    expect(readFileSync(join(root, "progress.local.md"), "utf-8")).toBe("private progress\n");
    expect(readFileSync(baselinePath)).toEqual(baselineBefore);
    expect(saveSpaceMock).toHaveBeenCalledTimes(registryWritesBefore);
  });
});
