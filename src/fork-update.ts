import { isValidRootNodeId } from "@ideaspaces/protocol";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { SpaceCopySnapshotFile } from "./auth/api.js";
import { configDir } from "./auth/config-dir.js";
import { declareRootIdentity } from "./root-identity.js";

export interface ForkUpdateConflict {
  path: string;
  kind: "content" | "add_add" | "delete_change";
}

export interface ForkSourceBaseline {
  source_root_node_id: string;
  source_head: string;
  files: Record<string, string>;
  conflicts: ForkUpdateConflict[];
}

export interface ForkUpdatePlan {
  incoming: Record<string, string>;
  writes: Record<string, string>;
  deletes: string[];
  conflicts: ForkUpdateConflict[];
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

function safePath(path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..") ||
    /[\0\r\n]/.test(path) ||
    !path.endsWith(".md")
  ) {
    throw new Error(`Unsafe Markdown path in source snapshot: ${path}`);
  }
  return path;
}

function isLocalOnly(path: string): boolean {
  return path.endsWith(".local.md");
}

function nodeId(content: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return null;
  try {
    const metadata = parse(content.slice(4, end));
    const value = metadata?.node_id;
    return typeof value === "string" && /^n_[0-9a-f]{12}(?:[0-9a-f]{12})?$/.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function replaceNodeId(content: string, replacement: string): string {
  const end = content.indexOf("\n---\n", 4);
  if (!content.startsWith("---\n") || end < 0) {
    throw new Error("Projected Markdown is missing valid frontmatter");
  }
  const header = content.slice(4, end);
  const nodeIdLine = /^node_id:\s*n_[0-9a-f]{12}(?:[0-9a-f]{12})?\s*$/m;
  if (!nodeIdLine.test(header)) throw new Error("Projected Markdown is missing node_id");
  const next = header.replace(nodeIdLine, `node_id: ${replacement}`);
  return `---\n${next}${content.slice(end)}`;
}

function rootIdentity(content: string | undefined): string | null {
  if (!content?.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return null;
  try {
    const value = parse(content.slice(4, end))?.root_node_id;
    return isValidRootNodeId(value) ? value : null;
  } catch {
    return null;
  }
}

export function normalizeSnapshot(
  files: SpaceCopySnapshotFile[],
  baseline: Record<string, string>,
): Record<string, string> {
  const incoming = new Map<string, string>();
  for (const file of files) {
    const path = safePath(file.path);
    if (isLocalOnly(path)) continue;
    if (incoming.has(path)) throw new Error(`Duplicate path in source snapshot: ${path}`);
    incoming.set(path, file.content);
  }

  const idMap = new Map<string, string>();
  const used = new Set<string>();
  for (const [path, content] of incoming) {
    const candidate = nodeId(content);
    if (!candidate) throw new Error(`Projected Markdown has no valid node_id: ${path}`);
    const prior = baseline[path] ? nodeId(baseline[path]) : null;
    const normalized = prior ?? candidate;
    if (used.has(normalized)) {
      throw new Error(`Projected Markdown normalizes to a duplicate node_id: ${path}`);
    }
    used.add(normalized);
    idMap.set(candidate, normalized);
  }

  const normalized: Record<string, string> = {};
  for (const [path, original] of incoming) {
    const candidate = nodeId(original)!;
    let content = replaceNodeId(original, idMap.get(candidate)!);
    for (const [from, to] of idMap) {
      if (from === to) continue;
      content = content.replaceAll(`node:${from}`, `node:${to}`);
      content = content.replaceAll(`/n/${from}`, `/n/${to}`);
    }
    if (path === "_agent/foundation.md") {
      const retainedRoot = rootIdentity(baseline[path]);
      const incomingRoot = rootIdentity(content);
      if (retainedRoot && incomingRoot && retainedRoot !== incomingRoot) {
        throw new Error("Projected foundation conflicts with the fork root identity");
      }
      if (retainedRoot && !incomingRoot) content = declareRootIdentity(content, retainedRoot);
    }
    normalized[path] = content;
  }
  return normalized;
}

function readLocal(path: string, root: string): string | null {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes Space: ${path}`);
  }
  return existsSync(absolute) ? readFileSync(absolute, "utf-8") : null;
}

export function planForkUpdate(
  baseline: ForkSourceBaseline,
  incoming: Record<string, string>,
  root: string,
): ForkUpdatePlan {
  const writes: Record<string, string> = {};
  const deletes: string[] = [];
  const conflicts = new Map(baseline.conflicts.map((item) => [item.path, item]));
  const paths = new Set([
    ...Object.keys(baseline.files),
    ...Object.keys(incoming),
    ...baseline.conflicts.map((item) => item.path),
  ]);

  for (const path of [...paths].sort()) {
    const before = baseline.files[path] ?? null;
    const after = incoming[path] ?? null;
    const local = readLocal(path, root);

    if (after === before) {
      if (conflicts.has(path) && local === after) conflicts.delete(path);
      continue;
    }
    if (local === before || local === after) {
      conflicts.delete(path);
      if (local !== after) {
        if (after === null) deletes.push(path);
        else writes[path] = after;
      }
      continue;
    }

    conflicts.set(path, {
      path,
      kind: before === null ? "add_add" : after === null ? "delete_change" : "content",
    });
  }

  return {
    incoming,
    writes,
    deletes,
    conflicts: [...conflicts.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf-8");
  }
}

/** Apply all selected worktree changes through one checked git patch. */
export function applyForkUpdate(plan: ForkUpdatePlan, root: string): void {
  const changed = [...Object.keys(plan.writes), ...plan.deletes];
  if (!changed.length) return;

  const temp = mkdtempSync(join(tmpdir(), "ideaspaces-update-"));
  const beforeDir = join(temp, "before");
  const afterDir = join(temp, "after");
  mkdirSync(beforeDir);
  mkdirSync(afterDir);
  try {
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (const path of changed) {
      const local = readLocal(path, root);
      if (local !== null) before[path] = local;
      if (path in plan.writes) after[path] = plan.writes[path];
    }
    writeTree(beforeDir, before);
    writeTree(afterDir, after);

    const diff = spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "diff", "--no-index", "--binary", "--no-renames", "--", "before", "after"],
      { cwd: temp, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (diff.error) throw diff.error;
    if (diff.status !== 0 && diff.status !== 1) {
      throw new Error((diff.stderr || "Could not prepare update patch").trim());
    }
    const patch = diff.stdout
      .replaceAll("a/before/", "a/")
      .replaceAll("b/after/", "b/");
    const applied = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], {
      cwd: root,
      input: patch,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (applied.error) throw applied.error;
    if (applied.status !== 0) {
      throw new Error((applied.stderr || applied.stdout || "Could not apply update").trim());
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function baselinePath(root: string): string {
  const key = createHash("sha256").update(resolve(root)).digest("hex");
  return join(configDir(), "fork-baselines", `${key}.json`);
}

export function loadForkBaseline(root: string): ForkSourceBaseline | null {
  const path = baselinePath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ForkSourceBaseline;
  } catch {
    throw new Error("The local fork update baseline is corrupt; no files were changed.");
  }
}

export function saveForkBaseline(root: string, baseline: ForkSourceBaseline): void {
  const path = baselinePath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(baseline) + "\n", { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Remove fork-local source state during an interrupted atomic installation. */
export function removeForkBaseline(root: string): void {
  const path = baselinePath(root);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function initialForkBaseline(
  root: string,
  sourceRootNodeId: string,
  sourceHead: string,
): ForkSourceBaseline {
  const roots = runGit(["rev-list", "--max-parents=0", "HEAD"], root)
    .trim()
    .split("\n")
    .filter(Boolean);
  if (roots.length !== 1) {
    throw new Error("The fork's initial copy commit is ambiguous; no files were changed.");
  }
  const commit = roots[0];
  const paths = runGit(["ls-tree", "-r", "--name-only", commit], root)
    .trim()
    .split("\n")
    .filter((path) => path.endsWith(".md"))
    .map(safePath)
    .filter((path) => !isLocalOnly(path));
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = runGit(["show", `${commit}:${path}`], root);
  return {
    source_root_node_id: sourceRootNodeId,
    source_head: sourceHead,
    files,
    conflicts: [],
  };
}

export function describeChanges(plan: ForkUpdatePlan): string[] {
  return [
    ...Object.keys(plan.writes).map((path) => `update ${path}`),
    ...plan.deletes.map((path) => `delete ${path}`),
    ...plan.conflicts.map((item) => `conflict ${item.path} (${item.kind})`),
  ];
}
