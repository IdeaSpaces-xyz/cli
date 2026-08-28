import { isValidRootNodeId } from "@ideaspaces/protocol";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
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
import { isExactAssetPayloadPath } from "./fork-paths.js";
import { sanitizedGitEnvironment } from "./git.js";
import { declareRootIdentity } from "./root-identity.js";

export interface ForkUpdateConflict {
  path: string;
  kind: "content" | "add_add" | "delete_change";
}

export interface ForkSourceBaseline {
  source_root_node_id: string;
  source_head: string;
  files: Record<string, string>;
  /** SHA-256 revisions for exact `_assets/` payload. Optional only for S3 compatibility. */
  assets?: Record<string, string>;
  conflicts: ForkUpdateConflict[];
}

export interface ForkUpdatePlan {
  incoming: Record<string, string>;
  incoming_assets: Record<string, string>;
  writes: Record<string, string>;
  asset_writes: Record<string, Buffer>;
  deletes: string[];
  /** Worktree revisions selected by the plan; apply refuses if any path moved meanwhile. */
  expected_revisions: Record<string, string | null>;
  conflicts: ForkUpdateConflict[];
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    env: sanitizedGitEnvironment(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout ?? "";
}

function runGitBuffer(args: string[], cwd: string): Buffer {
  const result = spawnSync("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: sanitizedGitEnvironment(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr?.toString("utf-8") ||
        result.stdout?.toString("utf-8") ||
        `git ${args.join(" ")} failed`).trim(),
    );
  }
  return Buffer.from(result.stdout ?? []);
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

function isAssetPayloadPath(path: string): boolean {
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    /[\0\r\n]/.test(path)
  ) {
    return false;
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "." || part === "..")) return false;
  return isExactAssetPayloadPath(path);
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

function readLocalBuffer(path: string, root: string): Buffer | null {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes Space: ${path}`);
  }
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Refusing to follow a symbolic link in update path: ${path}`);
    }
  }
  return existsSync(absolute) ? readFileSync(absolute) : null;
}

export function assetRevision(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function assetRevisions(
  assets: Array<{ path: string; content: Uint8Array }>,
): Record<string, string> {
  return Object.fromEntries(
    [...assets]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((asset) => [asset.path, assetRevision(asset.content)]),
  );
}

function conflictKind(before: unknown, after: unknown): ForkUpdateConflict["kind"] {
  return before === null ? "add_add" : after === null ? "delete_change" : "content";
}

export function planForkUpdate(
  baseline: ForkSourceBaseline,
  incoming: Record<string, string>,
  root: string,
  incomingAssets: Array<{ path: string; content: Buffer }> = [],
): ForkUpdatePlan {
  const writes: Record<string, string> = {};
  const assetWrites: Record<string, Buffer> = {};
  const deletes = new Set<string>();
  const expectedRevisions: Record<string, string | null> = {};
  const conflicts = new Map(baseline.conflicts.map((item) => [item.path, item]));
  const markdownPaths = new Set([
    ...Object.keys(baseline.files),
    ...Object.keys(incoming),
    ...baseline.conflicts
      .map((item) => item.path)
      .filter((path) => path.endsWith(".md") && !isAssetPayloadPath(path)),
  ]);

  for (const path of [...markdownPaths].sort()) {
    const before = baseline.files[path] ?? null;
    const after = incoming[path] ?? null;
    const beforeRevision = before === null ? null : assetRevision(Buffer.from(before, "utf-8"));
    const afterRevision = after === null ? null : assetRevision(Buffer.from(after, "utf-8"));
    const localContent = readLocalBuffer(path, root);
    const localRevision = localContent === null ? null : assetRevision(localContent);

    if (after === before) {
      if (conflicts.has(path) && localRevision === afterRevision) conflicts.delete(path);
      continue;
    }
    if (localRevision === beforeRevision || localRevision === afterRevision) {
      conflicts.delete(path);
      if (localRevision !== afterRevision) {
        expectedRevisions[path] = localRevision;
        if (after === null) deletes.add(path);
        else writes[path] = after;
      }
      continue;
    }

    conflicts.set(path, { path, kind: conflictKind(before, after) });
  }

  const incomingAssetBuffers = new Map(incomingAssets.map((asset) => [asset.path, asset.content]));
  const incomingAssetRevisions = assetRevisions(incomingAssets);
  const baselineAssets = baseline.assets ?? {};
  const assetPaths = new Set([
    ...Object.keys(baselineAssets),
    ...Object.keys(incomingAssetRevisions),
    ...baseline.conflicts.map((item) => item.path).filter(isAssetPayloadPath),
  ]);

  for (const path of [...assetPaths].sort()) {
    const before = baselineAssets[path] ?? null;
    const after = incomingAssetRevisions[path] ?? null;
    const localContent = readLocalBuffer(path, root);
    const local = localContent === null ? null : assetRevision(localContent);

    if (after === before) {
      if (conflicts.has(path) && local === after) conflicts.delete(path);
      continue;
    }
    if (local === before || local === after) {
      conflicts.delete(path);
      if (local !== after) {
        expectedRevisions[path] = local;
        if (after === null) deletes.add(path);
        else assetWrites[path] = incomingAssetBuffers.get(path)!;
      }
      continue;
    }

    conflicts.set(path, { path, kind: conflictKind(before, after) });
  }

  return {
    incoming,
    incoming_assets: incomingAssetRevisions,
    writes,
    asset_writes: assetWrites,
    deletes: [...deletes].sort(),
    expected_revisions: expectedRevisions,
    conflicts: [...conflicts.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function writeTree(root: string, files: Record<string, Buffer>): void {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** Apply all selected Markdown and exact `_assets/` changes through one checked binary git patch. */
export function applyForkUpdate(plan: ForkUpdatePlan, root: string): void {
  const changed = [...Object.keys(plan.writes), ...Object.keys(plan.asset_writes), ...plan.deletes];
  if (!changed.length) return;

  const temp = mkdtempSync(join(tmpdir(), "ideaspaces-update-"));
  const beforeDir = join(temp, "before");
  const afterDir = join(temp, "after");
  mkdirSync(beforeDir);
  mkdirSync(afterDir);
  try {
    const before: Record<string, Buffer> = {};
    const after: Record<string, Buffer> = {};
    for (const path of changed) {
      const local = readLocalBuffer(path, root);
      const currentRevision = local === null ? null : assetRevision(local);
      if (currentRevision !== plan.expected_revisions[path]) {
        throw new Error(`Local path changed while the source update was being planned: ${path}`);
      }
      if (local !== null) before[path] = local;
      if (Object.prototype.hasOwnProperty.call(plan.writes, path)) {
        after[path] = Buffer.from(plan.writes[path], "utf-8");
      } else if (Object.prototype.hasOwnProperty.call(plan.asset_writes, path)) {
        after[path] = plan.asset_writes[path];
      }
    }
    writeTree(beforeDir, before);
    writeTree(afterDir, after);

    const diff = spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "diff", "--no-index", "--binary", "--no-renames", "--", "before", "after"],
      {
        cwd: temp,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        env: sanitizedGitEnvironment(),
      },
    );
    if (diff.error) throw diff.error;
    if (diff.status !== 0 && diff.status !== 1) {
      throw new Error((diff.stderr || "Could not prepare update patch").trim());
    }
    const patch = (diff.stdout ?? "")
      .replaceAll("a/before/", "a/")
      .replaceAll("b/after/", "b/");
    const applied = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "-"], {
      cwd: root,
      input: patch,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnvironment(),
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

function initialForkCommit(root: string): string {
  const roots = runGit(["rev-list", "--max-parents=0", "HEAD"], root)
    .trim()
    .split("\n")
    .filter(Boolean);
  if (roots.length !== 1) {
    throw new Error("The fork's initial copy commit is ambiguous; no files were changed.");
  }
  return roots[0];
}

function initialCommitPaths(root: string, commit: string): string[] {
  return runGit(["ls-tree", "-r", "--name-only", "-z", commit], root)
    .split("\0")
    .filter(Boolean);
}

export function initialForkAssetRevisions(root: string): Record<string, string> {
  const commit = initialForkCommit(root);
  return Object.fromEntries(
    initialCommitPaths(root, commit)
      .filter(isAssetPayloadPath)
      .sort()
      .map((path) => [path, assetRevision(runGitBuffer(["show", `${commit}:${path}`], root))]),
  );
}

/** Add S4 asset revisions in memory without rewriting an S3 baseline during preview. */
export function withForkAssetBaseline(
  root: string,
  baseline: ForkSourceBaseline,
): { baseline: ForkSourceBaseline; migrated: boolean } {
  if (baseline.assets === undefined) {
    return {
      baseline: { ...baseline, assets: initialForkAssetRevisions(root) },
      migrated: true,
    };
  }
  for (const [path, revision] of Object.entries(baseline.assets)) {
    if (!isAssetPayloadPath(path) || !/^[0-9a-f]{64}$/.test(revision)) {
      throw new Error("The local fork asset baseline is corrupt; no files were changed.");
    }
  }
  return { baseline, migrated: false };
}

export function initialForkBaseline(
  root: string,
  sourceRootNodeId: string,
  sourceHead: string,
): ForkSourceBaseline {
  const commit = initialForkCommit(root);
  const paths = initialCommitPaths(root, commit);
  const files: Record<string, string> = {};
  const assets: Record<string, string> = {};
  for (const path of paths) {
    if (isAssetPayloadPath(path)) {
      assets[path] = assetRevision(runGitBuffer(["show", `${commit}:${path}`], root));
    } else if (path.endsWith(".md") && !isLocalOnly(path)) {
      files[safePath(path)] = runGit(["show", `${commit}:${path}`], root);
    }
  }
  return {
    source_root_node_id: sourceRootNodeId,
    source_head: sourceHead,
    files,
    assets,
    conflicts: [],
  };
}

export function describeChanges(plan: ForkUpdatePlan): string[] {
  return [
    ...Object.keys(plan.writes).map((path) => `update ${path}`),
    ...Object.keys(plan.asset_writes).map((path) => `update ${path}`),
    ...plan.deletes.map((path) => `delete ${path}`),
    ...plan.conflicts.map((item) => `conflict ${item.path} (${item.kind})`),
  ];
}
