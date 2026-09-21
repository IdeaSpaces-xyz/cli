import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { harvestLocalFiles } from "../local/workspace-files.js";
import { normalizeClaudeInvocation } from "../claude/tool-names.js";
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
  expect(ws.modified).toEqual([moved]); expect(ws.deleted).toEqual([original]); expect(ws.read).toEqual([findings]);
  expect(ws.file_coordinates[moved]).toMatchObject({ root_kind: "repo", path: "notes/one.md" });
  expect(basename(ws.file_coordinates[moved].root)).toBe("findings");
  expect(ws.file_coordinates[findings]).toMatchObject({ root_kind: "repo", path: "" });
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
  expect(ws.read).toEqual([launchFile, materialFile, pov]);
  expect(ws.file_coordinates[launchFile]).toEqual({ root: pov, path: "launch.md", root_kind: "folder" });
  expect(ws.file_coordinates[materialFile]).toEqual({ root, path: "docs/one.md", root_kind: "folder" });
  expect(ws.file_coordinates[pov]).toEqual({ root: pov, path: "", root_kind: "folder" });
});

it("harvests exploration tools including is_look, is_navigate, is_mount, is_unmount, is_status, is_release, is_explore, is_search", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-explore-"))); dirs.push(dir);
  mkdirSync(join(dir, "notes/sub"), { recursive: true });
  mkdirSync(join(dir, "mounted/docs"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  const noteOne = join(dir, "notes/one.md"); writeFileSync(noteOne, "# Note 1");
  const noteTwo = join(dir, "notes/sub/two.md"); writeFileSync(noteTwo, "# Note 2");
  const notesDir = join(dir, "notes");
  const subDir = join(dir, "notes/sub");
  const mountedDir = join(dir, "mounted");

  const ws = harvestLocalFiles([
    tool("is_navigate", { path: "notes" }),
    tool("is_look", { path: "notes/sub" }),
    tool("is_look", { path: "notes/one.md" }),
    tool("is_status", { path: "notes/sub/two.md" }),
    tool("is_mount", { path: "mounted" }),
    tool("is_unmount", { path: "mounted" }),
    tool("is_release", { path: "notes/one.md" }),
    tool("is_explore", { path: "notes" }),
    tool("is_search", { path: "notes/one.md" }),
  ], dir);

  expect(ws.read).toEqual([notesDir, subDir, noteOne, noteTwo, mountedDir]);
  expect(ws.file_coordinates[notesDir]).toEqual({ root: dir, path: "notes", root_kind: "repo" });
  expect(ws.file_coordinates[subDir]).toEqual({ root: dir, path: "notes/sub", root_kind: "repo" });
  expect(ws.file_coordinates[noteOne]).toEqual({ root: dir, path: "notes/one.md", root_kind: "repo" });
  expect(ws.file_coordinates[noteTwo]).toEqual({ root: dir, path: "notes/sub/two.md", root_kind: "repo" });
  expect(ws.file_coordinates[mountedDir]).toEqual({ root: dir, path: "mounted", root_kind: "repo" });
});

it("rejects directory paths for mutation tools (write, edit, is_write, is_commit)", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-mutation-dir-"))); dirs.push(dir);
  mkdirSync(join(dir, "notes"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  const noteFile = join(dir, "notes/one.md"); writeFileSync(noteFile, "# Note");

  const ws = harvestLocalFiles([
    tool("write", { path: "notes" }),
    tool("edit", { path: "notes" }),
    tool("is_write", { path: "notes" }),
    tool("is_commit", { paths: ["notes", "notes/one.md"] }),
  ], dir);

  expect(ws.modified).toEqual([noteFile]);
  expect(ws.file_coordinates[noteFile]).toEqual({ root: dir, path: "notes/one.md", root_kind: "repo" });
  expect(ws.file_coordinates[join(dir, "notes")]).toBeUndefined();
});

it("harvests is_get with dir, path, and local address coordinates", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-get-"))); dirs.push(dir);
  mkdirSync(join(dir, "cloned"), { recursive: true });
  mkdirSync(join(dir, "linked"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  const clonedDir = join(dir, "cloned");
  const linkedDir = join(dir, "linked");

  const ws = harvestLocalFiles([
    tool("is_get", { dir: "cloned", address: "https://ideaspaces.xyz/repos/n_123" }),
    tool("is_get", { path: "linked" }),
    tool("is_get", { address: linkedDir }),
  ], dir);

  expect(ws.read).toEqual([clonedDir, linkedDir]);
  expect(ws.file_coordinates[clonedDir]).toEqual({ root: dir, path: "cloned", root_kind: "repo" });
  expect(ws.file_coordinates[linkedDir]).toEqual({ root: dir, path: "linked", root_kind: "repo" });
});

it("resolves tool.args.root for mounted frame vs home authority", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-root-arg-"))); dirs.push(dir);
  const home = join(dir, "home"); const mount = join(dir, "mount");
  mkdirSync(join(home, "notes"), { recursive: true }); mkdirSync(join(mount, "docs"), { recursive: true });
  for (const root of [home, mount]) execFileSync("git", ["init", "-q", root]);
  const homeNote = join(home, "notes/one.md"); writeFileSync(homeNote, "# Home");
  const mountDoc = join(mount, "docs/ref.md"); writeFileSync(mountDoc, "# Mount");

  const ws = harvestLocalFiles([
    // "home" resolves against home authority launchCwd
    tool("is_look", { root: "home", path: "notes/one.md" }),
    // Mounted root path resolves against the mount
    tool("is_look", { root: mount, path: "docs/ref.md" }),
    tool("is_navigate", { root: mount, path: "docs" }),
  ], home);

  expect(ws.read).toEqual([homeNote, mountDoc, join(mount, "docs")]);
  expect(ws.file_coordinates[homeNote]).toEqual({ root: home, path: "notes/one.md", root_kind: "repo" });
  expect(ws.file_coordinates[mountDoc]).toEqual({ root: mount, path: "docs/ref.md", root_kind: "repo" });
  expect(ws.file_coordinates[join(mount, "docs")]).toEqual({ root: mount, path: "docs", root_kind: "repo" });
});

it("normalizes Claude exploration tools (LS, Glob, Grep) with explicit and omitted path", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-claude-"))); dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  const srcDir = join(dir, "src");
  const codeFile = join(dir, "src/app.ts"); writeFileSync(codeFile, "console.log('hi');");

  const claudeTools: ToolInvocation[] = [
    { name: "LS", args: { path: "src" }, isError: false, result: "ok" },
    { name: "Glob", args: { path: "src" }, isError: false, result: "ok" },
    { name: "Grep", args: { path: "src/app.ts" }, isError: false, result: "ok" },
    // Omitted path in Claude LS defaults to "."
    { name: "LS", args: {}, isError: false, result: "ok" },
    // Omitted path in Glob/Grep searches whole workspace without marking root as a read folder
    { name: "Glob", args: { pattern: "*.ts" }, isError: false, result: "ok" },
    { name: "Grep", args: { pattern: "console" }, isError: false, result: "ok" },
    { name: "mcp__ideaspaces__is_look", args: { path: "src/app.ts" }, isError: false, result: "ok" },
  ];

  const normalized = claudeTools.map(normalizeClaudeInvocation);
  const ws = harvestLocalFiles(normalized, dir);

  expect(ws.read).toEqual([srcDir, codeFile, dir]);
  expect(ws.file_coordinates[srcDir]).toEqual({ root: dir, path: "src", root_kind: "repo" });
  expect(ws.file_coordinates[codeFile]).toEqual({ root: dir, path: "src/app.ts", root_kind: "repo" });
  expect(ws.file_coordinates[dir]).toEqual({ root: dir, path: "", root_kind: "repo" });
});

it("defaults navigation/ls with omitted path to . while unscoped search tools skip root", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-pi-explore-"))); dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);

  const ws = harvestLocalFiles([
    tool("is_navigate", {}),
    tool("is_navigate", { path: "" }),
    tool("ls", {}),
    // Unscoped search does not mark root
    tool("glob", { pattern: "*.md" }),
    tool("grep", { pattern: "text" }),
    tool("find", {}),
  ], dir);

  expect(ws.read).toEqual([dir]);
  expect(ws.file_coordinates[dir]).toEqual({ root: dir, path: "", root_kind: "repo" });
});

it.skipIf(process.platform === "win32")("skips a path whose file state cannot be read", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "workspace-unreadable-"))); dirs.push(root);
  const loop = join(root, "loop.md"); symlinkSync("loop.md", loop);
  expect(harvestLocalFiles([tool("read", { path: loop })], root).read).toEqual([]);
});
