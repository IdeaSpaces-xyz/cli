import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyForkUpdate,
  assetRevisions,
  initialForkBaseline,
  normalizeSnapshot,
  planForkUpdate,
  withForkAssetBaseline,
  type ForkSourceBaseline,
} from "../fork-update.js";

const A = "n_aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "n_bbbbbbbbbbbbbbbbbbbbbbbb";
const X = "n_111111111111111111111111";
const Y = "n_222222222222222222222222";

function md(id: string, body: string): string {
  return `---\nnode_id: ${id}\n---\n${body}\n`;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "is-fork-update-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, content: string | Buffer): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function baseline(files: Record<string, string>): ForkSourceBaseline {
  return {
    source_root_node_id: "n_ffffffffffffffffffffffff",
    source_head: "a".repeat(40),
    files,
    assets: {},
    conflicts: [],
  };
}

describe("fork update merge", () => {
  it("normalizes regenerated ids and internal links to the fork's existing path ids", () => {
    const normalized = normalizeSnapshot(
      [
        { path: "README.md", content: md(X, `See node:${Y}`) },
        { path: "_agent/guide.md", content: md(Y, `Back node:${X}`) },
        { path: "progress.local.md", content: md("n_333333333333333333333333", "private") },
      ],
      {
        "README.md": md(A, `See node:${B}`),
        "_agent/guide.md": md(B, `Back node:${A}`),
      },
    );

    expect(normalized["README.md"]).toBe(md(A, `See node:${B}`));
    expect(normalized["_agent/guide.md"]).toBe(md(B, `Back node:${A}`));
    expect(normalized).not.toHaveProperty("progress.local.md");
  });

  it("retains the destination root identity while normalizing later source snapshots", () => {
    const rootNodeId = "n_abcdefabcdefabcdefabcdef";
    const baselineFoundation = `---\nnode_id: ${A}\nroot_node_id: ${rootNodeId}\n---\nOld\n`;
    const incomingFoundation = md(X, "New");

    const normalized = normalizeSnapshot(
      [{ path: "_agent/foundation.md", content: incomingFoundation }],
      { "_agent/foundation.md": baselineFoundation },
    );

    expect(normalized["_agent/foundation.md"]).toContain(`node_id: ${A}`);
    expect(normalized["_agent/foundation.md"]).toContain(`root_node_id: ${rootNodeId}`);
    expect(normalized["_agent/foundation.md"]).toContain("New");
  });

  it("applies source-only changes and preserves edits, additions, progress, and conflicts", () => {
    const before = {
      "changed.md": md(A, "old"),
      "conflict.md": md(B, "old"),
      "deleted.md": md("n_cccccccccccccccccccccccc", "delete me"),
    };
    for (const [path, content] of Object.entries(before)) write(path, content);
    write("conflict.md", md(B, "local edit"));
    write("local.md", "local addition\n");
    write("progress.local.md", "private progress\n");

    const incoming = {
      "changed.md": md(A, "new"),
      "conflict.md": md(B, "source edit"),
      "added.md": md("n_dddddddddddddddddddddddd", "added"),
    };
    const plan = planForkUpdate(baseline(before), incoming, root);

    expect(Object.keys(plan.writes).sort()).toEqual(["added.md", "changed.md"]);
    expect(plan.deletes).toEqual(["deleted.md"]);
    expect(plan.conflicts).toEqual([{ path: "conflict.md", kind: "content" }]);

    applyForkUpdate(plan, root);

    expect(readFileSync(join(root, "changed.md"), "utf-8")).toBe(incoming["changed.md"]);
    expect(readFileSync(join(root, "added.md"), "utf-8")).toBe(incoming["added.md"]);
    expect(() => readFileSync(join(root, "deleted.md"))).toThrow();
    expect(readFileSync(join(root, "conflict.md"), "utf-8")).toBe(md(B, "local edit"));
    expect(readFileSync(join(root, "local.md"), "utf-8")).toBe("local addition\n");
    expect(readFileSync(join(root, "progress.local.md"), "utf-8")).toBe("private progress\n");
  });

  it("updates exact binary assets while preserving local asset conflicts and staged bystanders", () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    const oldChanged = Buffer.from([0, 1, 2, 3]);
    const oldConflict = Buffer.from([4, 5, 6]);
    const oldDeleted = Buffer.from([7, 8]);
    write("_assets/changed.bin", oldChanged);
    write("_assets/conflict.bin", oldConflict);
    write("docs/_assets/deleted.bin", oldDeleted);
    write("bystander.txt", "before\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "copy"], { cwd: root });
    write("_assets/conflict.bin", Buffer.from([9, 9, 9]));
    write("bystander.txt", "staged\n");
    execFileSync("git", ["add", "bystander.txt"], { cwd: root });
    const stagedBefore = execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: root,
      encoding: "utf-8",
    });

    const base = baseline({});
    base.assets = assetRevisions([
      { path: "_assets/changed.bin", content: oldChanged },
      { path: "_assets/conflict.bin", content: oldConflict },
      { path: "docs/_assets/deleted.bin", content: oldDeleted },
    ]);
    const incomingAssets = [
      { path: "_assets/changed.bin", content: Buffer.from([3, 2, 1, 0]) },
      { path: "_assets/conflict.bin", content: Buffer.from([6, 5, 4]) },
      { path: "docs/_assets/added.bin", content: Buffer.from([10, 11]) },
    ];
    const plan = planForkUpdate(base, {}, root, incomingAssets);

    expect(Object.keys(plan.asset_writes).sort()).toEqual([
      "_assets/changed.bin",
      "docs/_assets/added.bin",
    ]);
    expect(plan.deletes).toEqual(["docs/_assets/deleted.bin"]);
    expect(plan.conflicts).toEqual([{ path: "_assets/conflict.bin", kind: "content" }]);

    applyForkUpdate(plan, root);

    expect(readFileSync(join(root, "_assets/changed.bin"))).toEqual(Buffer.from([3, 2, 1, 0]));
    expect(readFileSync(join(root, "_assets/conflict.bin"))).toEqual(Buffer.from([9, 9, 9]));
    expect(readFileSync(join(root, "docs/_assets/added.bin"))).toEqual(Buffer.from([10, 11]));
    expect(() => readFileSync(join(root, "docs/_assets/deleted.bin"))).toThrow();
    expect(execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: root,
      encoding: "utf-8",
    })).toBe(stagedBefore);
  });

  it.skipIf(process.platform === "win32")(
    "refuses to follow a symlink in a selected update path",
    () => {
      const outside = join(root, "outside.md");
      write("outside.md", md(A, "outside"));
      symlinkSync(outside, join(root, "linked.md"));

      expect(() =>
        planForkUpdate(
          baseline({ "linked.md": md(A, "old") }),
          { "linked.md": md(A, "source") },
          root,
        ),
      ).toThrow(/symbolic link/);
      expect(readFileSync(outside, "utf-8")).toBe(md(A, "outside"));
    },
  );

  it("refuses to overwrite a local edit that races the plan", () => {
    const old = md(A, "old");
    const source = md(A, "source");
    write("note.md", old);
    const plan = planForkUpdate(baseline({ "note.md": old }), { "note.md": source }, root);
    write("note.md", md(A, "raced local edit"));

    expect(() => applyForkUpdate(plan, root)).toThrow(/changed while.*planned/);
    expect(readFileSync(join(root, "note.md"), "utf-8")).toBe(md(A, "raced local edit"));
  });

  it("keeps a skipped conflict alive after the baseline advances", () => {
    const old = md(A, "old");
    const source = md(A, "source");
    write("note.md", md(A, "local"));
    const first = planForkUpdate(baseline({ "note.md": old }), { "note.md": source }, root);
    const advanced = { ...baseline(first.incoming), conflicts: first.conflicts };

    const second = planForkUpdate(advanced, first.incoming, root);

    expect(second.writes).toEqual({});
    expect(second.conflicts).toEqual([{ path: "note.md", kind: "content" }]);
  });

  it("reconstructs the initial source baseline from the fork's first commit", () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    write("README.md", md(A, "initial"));
    write("_agent/guide.md", md(B, "guide"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "copy"], { cwd: root });
    write("README.md", md(A, "local"));
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "local"], { cwd: root });

    const result = initialForkBaseline(
      root,
      "n_ffffffffffffffffffffffff",
      "a".repeat(40),
    );

    expect(result.files["README.md"]).toBe(md(A, "initial"));
    expect(result.files["_agent/guide.md"]).toBe(md(B, "guide"));
    expect(result.assets).toEqual({});
  });

  it("hydrates an S3 asset baseline from the import commit without trusting later local bytes", () => {
    execFileSync("git", ["init"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    const imported = Buffer.from([0, 255, 10]);
    write("_assets/picture.bin", imported);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "copy"], { cwd: root });
    write("_assets/picture.bin", Buffer.from([1, 2, 3]));

    const hydrated = withForkAssetBaseline(root, {
      source_root_node_id: "n_ffffffffffffffffffffffff",
      source_head: "a".repeat(40),
      files: {},
      conflicts: [],
    });

    expect(hydrated.migrated).toBe(true);
    expect(hydrated.baseline.assets).toEqual(
      assetRevisions([{ path: "_assets/picture.bin", content: imported }]),
    );
  });
});
