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

function gitOrThrow(args: string[], cwd?: string): string {
  const r = git(args, cwd);
  if (!r.ok) throw new GitError(r.err || r.out || `git ${args.join(" ")} failed`);
  return r.out;
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

/** Paths that are staged in the index (first status char is not space/?). */
export function stagedPaths(cwd?: string): string[] {
  return statusEntries(cwd)
    .filter((e) => e.status[0] !== " " && e.status[0] !== "?")
    .map((e) => e.path);
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
