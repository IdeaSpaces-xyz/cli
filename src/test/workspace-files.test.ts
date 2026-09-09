import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { harvestLocalFiles } from "../pi/workspace-files.js";
import type { ToolInvocation } from "@ideaspaces/sdk";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tool = (name: string, args: Record<string, unknown>, isError = false): ToolInvocation => ({ name, args, isError, result: "ok" });
it("preserves sibling repo coordinates, native edits, explicit cwd, and removed originals", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-paths-"))); dirs.push(dir);
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
  expect(basename(ws.file_coordinates[moved].root)).toBe("findings");
});
it("keeps POV and nested non-repo material in their selected folder roots", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-folder-"))); dirs.push(dir);
  const pov = join(dir, "agent"); const root = join(dir, "material");
  mkdirSync(pov); mkdirSync(join(root, "docs"), { recursive: true });
  const launchFile = join(pov, "launch.md"); const materialFile = join(root, "docs/one.md");
  writeFileSync(launchFile, "# Launch"); writeFileSync(materialFile, "# Material");
  const ws = harvestLocalFiles([
    tool("is_navigate", { path: "/elsewhere" }),
    tool("read", { path: "launch.md" }),
    tool("read", { path: materialFile }),
    tool("is_inspect", { cwd: root, path: "docs/one.md" }),
    tool("read", { path: "." }),
    tool("bash", { command: "cat secret.md" }),
  ], pov, root);
  expect(ws.read).toEqual([launchFile, materialFile]);
  expect(ws.file_coordinates[launchFile]).toEqual({ root: pov, path: "launch.md", root_kind: "folder" });
  expect(ws.file_coordinates[materialFile]).toEqual({ root, path: "docs/one.md", root_kind: "folder" });
});
it.skipIf(process.platform === "win32")("skips a path whose file state cannot be read", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-unreadable-"))); dirs.push(root);
  const loop = join(root, "loop.md"); symlinkSync("loop.md", loop);
  expect(harvestLocalFiles([tool("read", { path: loop })], root).read).toEqual([]);
});
