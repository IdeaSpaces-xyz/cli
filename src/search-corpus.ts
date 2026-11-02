/**
 * What a search reads: the Markdown under one or more roots, each listed the
 * way its owner would — Git's own view for a repository (tracked plus
 * untracked-but-not-ignored), a bounded walk for a plain folder — plus, when
 * asked, the root's own local Threads. Nothing here scores; see search.ts.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitBinary, sanitizedGitEnvironment } from "./git.js";
import type { HitKind } from "./search-query.js";
import type { SearchDoc } from "./search.js";

/** Folders a plain-folder walk never enters (Desktop's list, plus dot-entries). */
const WALK_SKIP = new Set(["node_modules", "_assets", "target", "dist"]);
const WALK_MAX_DEPTH = 12;
const WALK_MAX_FILES = 50_000;
const LIST_CONCURRENCY = 8;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
/** A file larger than this is not a Note; skipped rather than read. */
export const MAX_DOC_BYTES = 4 * 1024 * 1024;

export interface RootListing {
  /** Canonical absolute root. */
  root: string;
  listing: "git" | "walk";
  /** Root-relative POSIX paths of Markdown files to read. */
  files: string[];
  /** True when the walk stopped at its cap. */
  truncated?: boolean;
  /** Set when the root could not be listed; `files` is then empty. */
  error?: string;
  /** Non-fatal notes, e.g. a refused `_threads` symlink. */
  warnings?: string[];
}

export interface RootRequest {
  /** As given by the caller. */
  input: string;
  /** Canonical absolute directory, or null when it cannot be used. */
  root: string | null;
  error?: string;
}

/** Resolve caller roots: absolute or relative to `cwd`, existing directories, canonical, de-duplicated. */
export function resolveRoots(inputs: string[], cwd = process.cwd()): RootRequest[] {
  const seen = new Set<string>();
  const out: RootRequest[] = [];
  for (const input of inputs) {
    const abs = isAbsolute(input) ? input : resolve(cwd, input);
    let root: string;
    try {
      root = realpathSync.native(abs);
      if (!statSync(root).isDirectory()) {
        out.push({ input, root: null, error: `Not a folder: ${input}` });
        continue;
      }
    } catch {
      out.push({ input, root: null, error: `No such folder: ${input}` });
      continue;
    }
    if (seen.has(root)) continue;
    seen.add(root);
    out.push({ input, root });
  }
  return out;
}

/** The deepest folder containing every root — what `in:` folders are written from. */
export function commonBase(roots: string[]): string {
  if (roots.length === 0) return "";
  let base = roots[0];
  for (const root of roots.slice(1)) {
    while (base !== root && !root.startsWith(base.endsWith(sep) ? base : base + sep)) {
      const parent = dirname(base);
      if (parent === base) return base;
      base = parent;
    }
  }
  return base;
}

/** A root-relative path as a POSIX path. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

export function isThreadPath(path: string): boolean {
  return path.split("/").includes("_threads");
}

/** A file's kind inside its root: a local Thread's README, one of its posts, or a Note. */
export function hitKind(path: string): HitKind {
  const parts = path.split("/");
  if (parts.length === 3 && parts[0] === "_threads") {
    return parts[2] === "README.md" ? "thread_readme" : "thread_post";
  }
  return "note";
}

interface GitList { ok: true; paths: string[] }
interface GitFail { ok: false; notRepo: boolean; message: string }

function gitListFiles(root: string): Promise<GitList | GitFail> {
  return new Promise((done) => {
    execFile(
      gitBinary(),
      ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, env: sanitizedGitEnvironment(), maxBuffer: GIT_MAX_BUFFER, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          done({ ok: true, paths: stdout.split("\0").filter(Boolean) });
          return;
        }
        const text = String(stderr || error.message);
        const notRepo = /not a git repository/i.test(text);
        const spawnFailed = typeof (error as NodeJS.ErrnoException).code === "string";
        done({
          ok: false,
          notRepo: notRepo || spawnFailed,
          message: spawnFailed ? `git could not run (${(error as NodeJS.ErrnoException).code}); listed as a plain folder` : text.trim(),
        });
      },
    );
  });
}

/** A bounded walk of a plain folder. Nested repositories are their own roots and are not entered. */
function walkMarkdown(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const visit = (dir: string, depth: number) => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        if (files.length >= WALK_MAX_FILES) {
          truncated = true;
          return;
        }
        files.push(toPosix(relative(root, abs)));
      } else if (entry.isDirectory() && depth < WALK_MAX_DEPTH && !WALK_SKIP.has(entry.name)) {
        if (existsSync(join(abs, ".git"))) continue;
        visit(abs, depth + 1);
      }
    }
  };
  visit(root, 0);
  return { files, truncated };
}

/**
 * The root's own local Threads: `_threads/<slug>/README.md` and the posts
 * beside it. Only a root that is itself a Space (it has `_agent/agreement.md`)
 * has them — a nested repo never reads its parent Space's Threads. Symlinks
 * are refused, as the Threads reader refuses them.
 */
function ownThreadFiles(root: string, warnings: string[]): string[] {
  if (!existsSync(join(root, "_agent", "agreement.md"))) return [];
  const base = join(root, "_threads");
  let stat;
  try {
    stat = lstatSync(base);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) {
    warnings.push("_threads is a symlink; its Threads were not searched");
    return [];
  }
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  for (const thread of readdirSync(base, { withFileTypes: true })) {
    if (!thread.isDirectory() || thread.name.startsWith(".")) continue;
    let entries;
    try {
      entries = readdirSync(join(base, thread.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) out.push(`_threads/${thread.name}/${entry.name}`);
    }
  }
  return out;
}

async function listRoot(root: string, threads: boolean): Promise<RootListing> {
  const warnings: string[] = [];
  const listed = await gitListFiles(root);
  let listing: RootListing["listing"];
  let paths: string[];
  let truncated = false;
  if (listed.ok) {
    listing = "git";
    paths = listed.paths;
  } else if (listed.notRepo) {
    listing = "walk";
    if (!/not a git repository/i.test(listed.message)) warnings.push(listed.message);
    const walked = walkMarkdown(root);
    paths = walked.files;
    truncated = walked.truncated;
  } else {
    return { root, listing: "git", files: [], error: `Could not list files: ${listed.message}` };
  }
  const files = new Set(paths.map(toPosix).filter((p) => p.endsWith(".md") && (threads || !isThreadPath(p))));
  if (threads) for (const p of ownThreadFiles(root, warnings)) files.add(p);
  return {
    root,
    listing,
    files: [...files].sort(),
    ...(truncated ? { truncated } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * List every root, a few at a time. A file reachable from two roots belongs
 * to the deeper one, so a nested repository's Notes are never counted twice.
 */
export async function listRoots(roots: string[], threads: boolean): Promise<RootListing[]> {
  const listings: RootListing[] = new Array(roots.length);
  let next = 0;
  const worker = async () => {
    while (next < roots.length) {
      const index = next++;
      listings[index] = await listRoot(roots[index], threads);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, roots.length) }, worker));

  const claimed = new Set<string>();
  // Roots are canonical, so a root nested in another always has the longer path:
  // longest first means the deeper root claims a shared file.
  const byDepth = [...listings].sort((a, b) => b.root.length - a.root.length);
  for (const listing of byDepth) {
    listing.files = listing.files.filter((p) => {
      const abs = join(listing.root, p);
      if (claimed.has(abs)) return false;
      claimed.add(abs);
      return true;
    });
  }
  return listings;
}

/**
 * Read lazily, one file at a time. Unreadable, oversized or non-regular files
 * are skipped — a search should degrade, not abort. A Git-listed symlink is
 * followed, as single-repo search always has; walks and Thread listings never
 * yield one.
 */
export function* readCorpus(
  files: Array<{ root: string; path: string }>,
  withRoot: boolean,
  /** Incremented per root for each file actually read. */
  readCounts?: Map<string, number>,
): Generator<SearchDoc> {
  for (const { root, path } of files) {
    const abs = join(root, path);
    try {
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > MAX_DOC_BYTES) continue;
      const content = readFileSync(abs, "utf-8");
      readCounts?.set(root, (readCounts.get(root) ?? 0) + 1);
      yield withRoot ? { root, path, content } : { path, content };
    } catch {
      continue;
    }
  }
}

/** A file's modification time, ISO, or null when it has gone. */
export function modifiedAt(root: string, path: string): string | null {
  try {
    return statSync(join(root, path)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** The display name of a root, for human output. */
export function rootLabel(root: string): string {
  return basename(root) || root;
}
