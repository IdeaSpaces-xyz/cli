/**
 * Local git operations for the CLI's capture verbs.
 *
 * The safety core is {@link commitPaths}: it commits **only** the paths passed
 * to it, never a bare `git commit` that would sweep the user's other staged
 * work into a capture commit. Every mutating path through the CLI funnels
 * here so that rule lives in exactly one place.
 *
 * Synchronous (spawnSync) to match the rest of the CLI — these are short-lived
 * one-shot invocations. The SDK's async `gitState` covers the read side; this
 * module owns the writes git can't do read-only.
 */

import { spawnSync } from "node:child_process";

export class GitError extends Error {}

function git(args: string[], cwd?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { encoding: "utf-8", cwd });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** Exit code of a git invocation (for `--quiet` diff probes). -1 on spawn error. */
function gitExit(args: string[], cwd?: string): number {
  const r = spawnSync("git", args, { encoding: "utf-8", cwd });
  return r.status ?? -1;
}

function gitOrThrow(args: string[], cwd?: string): string {
  const r = git(args, cwd);
  if (!r.ok) throw new GitError(r.err || r.out || `git ${args.join(" ")} failed`);
  return r.out;
}

/** Clone `url` into `dir`. The git credential helper supplies auth. */
export function cloneRepo(url: string, dir: string): void {
  gitOrThrow(["clone", url, dir]);
}

/** Read a repo-local git config value, or null if unset. */
export function localConfig(key: string, cwd?: string): string | null {
  const r = git(["config", "--local", key], cwd);
  return r.ok ? r.out || null : null;
}

/** Set a repo-local git config value. */
export function setLocalConfig(key: string, value: string, cwd?: string): void {
  gitOrThrow(["config", "--local", key, value], cwd);
}

/** Absolute git toplevel for `cwd` (or process cwd). Throws if not in a repo. */
export function repoRoot(cwd?: string): string {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  if (!r.ok) throw new GitError("not inside a git repository");
  return r.out;
}

export function headSha(cwd?: string): string {
  return gitOrThrow(["rev-parse", "HEAD"], cwd);
}

/** `git add` the given paths. No-op for an empty list. */
export function stagePaths(paths: string[], cwd?: string): void {
  if (!paths.length) return;
  gitOrThrow(["add", "--", ...paths], cwd);
}

/**
 * Commit **only** the given paths. Uses the explicit pathspec form
 * (`git commit -m <msg> -- <p1> <p2>`), so anything else the user has staged
 * is left untouched. Refuses an empty path list — never a bare commit.
 */
export function commitPaths(message: string, paths: string[], cwd?: string): string {
  if (!paths.length) throw new GitError("refusing to commit with no paths");
  // Stage the named paths first so the commit captures their current content,
  // then commit exactly those pathspecs.
  gitOrThrow(["add", "--", ...paths], cwd);
  gitOrThrow(["commit", "-q", "-m", message, "--", ...paths], cwd);
  return headSha(cwd);
}

/**
 * Content blob sha of a file (`git hash-object`), or null if it doesn't exist.
 *
 * This is the optimistic-concurrency token: it depends only on file content,
 * not on commits, so it works for staged-but-uncommitted captures. `is_write`
 * returns it; `if_match` compares against it.
 */
export function blobSha(path: string, cwd?: string): string | null {
  const r = git(["hash-object", "--", path], cwd);
  return r.ok ? r.out : null;
}

export interface PathStatus {
  path: string;
  exists: boolean;
  /** Content blob sha, or null when the file is absent. */
  sha: string | null;
  /** Staged in the index. */
  inIndex: boolean;
  /** Has unstaged modifications. */
  modified: boolean;
  /** In the git index (staged or committed) — `ls-files --error-unmatch`. */
  inTracked: boolean;
}

/** Single-path git state — the `if_match` token source for first updates. */
export function pathStatus(path: string, cwd?: string): PathStatus {
  const sha = blobSha(path, cwd);
  // Use diff exit codes rather than porcelain columns — the git() helper trims
  // output, which would destroy the leading-space that separates the staged (X)
  // and worktree (Y) columns. `--quiet` exits 1 when there are differences.
  return {
    path,
    exists: sha !== null,
    sha,
    inIndex: gitExit(["diff", "--cached", "--quiet", "--", path], cwd) === 1,
    modified: gitExit(["diff", "--quiet", "--", path], cwd) === 1,
    inTracked: git(["ls-files", "--error-unmatch", "--", path], cwd).ok,
  };
}

export interface PorcelainEntry {
  /** Two-char XY status from `git status --porcelain`. */
  status: string;
  path: string;
}

/** Parsed `git status --porcelain` entries. */
export function statusEntries(cwd?: string): PorcelainEntry[] {
  const out = gitOrThrow(["status", "--porcelain"], cwd);
  if (!out) return [];
  return out.split("\n").map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3),
  }));
}

/** True if any tracked file has staged or unstaged modifications. */
export function isDirty(cwd?: string): boolean {
  return statusEntries(cwd).some((e) => !e.status.startsWith("??"));
}

/**
 * Paths currently staged in the index (repo-relative). Uses
 * `git diff --cached --name-only` — clean path output, no porcelain-column
 * parsing (the git() helper trims, which would corrupt status columns).
 */
export function stagedPaths(cwd?: string): string[] {
  const r = git(["diff", "--cached", "--name-only"], cwd);
  if (!r.ok || !r.out) return [];
  return r.out.split("\n").filter(Boolean);
}

/** Knowledge path: a markdown file, or anything under an `_agent/` dir. */
export function isIdeaspacePath(path: string): boolean {
  return path.endsWith(".md") || path.split("/").includes("_agent");
}

/** Staged paths that are ideaspace knowledge (markdown or `_agent/`). */
export function stagedIdeaspacePaths(cwd?: string): string[] {
  return stagedPaths(cwd).filter(isIdeaspacePath);
}

export interface RemoteState {
  /** Upstream ref (e.g. `origin/main`), or null if none configured. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Fetch from the upstream remote. Throws on failure (e.g. no network). */
export function fetch(cwd?: string): void {
  gitOrThrow(["fetch"], cwd);
}

/** Ahead/behind vs upstream after a fetch. `upstream: null` when unset. */
export function remoteState(cwd?: string): RemoteState {
  const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd);
  if (!up.ok || !up.out) return { upstream: null, ahead: 0, behind: 0 };
  const counts = git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], cwd);
  if (!counts.ok) return { upstream: up.out, ahead: 0, behind: 0 };
  const [behind, ahead] = counts.out.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { upstream: up.out, ahead, behind };
}

/** Rebase onto upstream. Throws (leaving git's state) on conflict. */
export function rebaseOntoUpstream(cwd?: string): void {
  gitOrThrow(["rebase", "@{upstream}"], cwd);
}

/** Merge upstream (non-rebase integration). */
export function mergeUpstream(cwd?: string): void {
  gitOrThrow(["merge", "--no-edit", "@{upstream}"], cwd);
}

export function push(cwd?: string): void {
  gitOrThrow(["push"], cwd);
}
