import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { harvestLocalFiles } from "../pi/workspace-files.js";
import type { ToolInvocation } from "@ideaspaces/sdk";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tool = (name: string, args: Record<string, unknown>, isError = false): ToolInvocation => ({ name, args, isError, result: "ok" });
it("preserves sibling repo coordinates, native edits, explicit cwd, and removed originals", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-paths-"))); dirs.push(dir);
  const source = join(dir, "source"); const findings = join(dir, "findings");
  for (const root of [source, findings]) { mkdirSync(join(root, "notes"), { recursive: true }); execFileSync("git", ["init", "-q", root]); }
  const moved = join(findings, "notes/one.md"); writeFileSync(moved, "# One");
  const original = join(source, "notes/one.md");
  const ws = harvestLocalFiles([
    tool("read", { path: original }),
    tool("write", { path: moved }), tool("edit", { path: moved }),
    tool("is_commit", { cwd: findings, paths: ["notes/one.md"] }),
    tool("is_commit", { cwd: source, paths: ["notes/one.md"] }),
    tool("read", { path: "notes/one.md", cwd: findings }, true),
    tool("is_navigate", { path: findings }),
  ], source);
  expect(ws.modified).toEqual([moved]); expect(ws.deleted).toEqual([original]); expect(ws.read).toEqual([]);
  expect(ws.file_coordinates[moved]).toMatchObject({ root_kind: "repo", path: "notes/one.md" });
  expect(ws.file_coordinates[moved].root.endsWith("/findings")).toBe(true);
});
it("uses launch cwd for native tools, ignores navigation and shell text, and supports non-repo folders", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-folder-"))); dirs.push(root);
  writeFileSync(join(root, "one.md"), "# One");
  const ws = harvestLocalFiles([
    tool("is_navigate", { path: "/elsewhere" }),
    tool("read", { path: "one.md" }),
    tool("is_inspect", { cwd: root, path: "one.md" }),
    tool("read", { path: "." }),
    tool("bash", { command: "cat secret.md" }),
  ], root);
  expect(ws.read).toEqual([join(root, "one.md")]);
  expect(ws.file_coordinates[join(root, "one.md")]).toEqual({ root, path: "one.md", root_kind: "folder" });
});
