import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyForkUpdate,
  initialForkBaseline,
  normalizeSnapshot,
  planForkUpdate,
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

function write(path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function baseline(files: Record<string, string>): ForkSourceBaseline {
  return {
    source_root_node_id: "n_ffffffffffffffffffffffff",
    source_head: "a".repeat(40),
    files,
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
  });
});
