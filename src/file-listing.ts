/**
 * A bounded, noise-excluding walk of a folder tree — the data source for
 * @-mention autocomplete on the desktop's local Pi surface (and any surface that
 * needs "what files and folders are under here").
 *
 * Folders are typed so the caller can distinguish a plain folder from a code repo
 * (`.git`) or an ideaspace repo (`_agent/`) — an ideaspace repo is also a git
 * repo, so the `_agent/` check wins. The walk skips the standard noise dirs
 * (shared with the catalog scan) and dot-entries, and is capped on scan size and
 * depth so a huge workspace can't stall an autocomplete keystroke. Pure and
 * synchronous so it is trivially testable; unreadable dirs are skipped, never
 * fatal — a listing should degrade, not abort.
 *
 * Known limits (fine for a markdown ideaspace workspace; revisit if code repos
 * become a primary target):
 * - No `.gitignore` awareness — a code repo's build output (dist/, target/, …)
 *   is listed. A name denylist is deliberately NOT used: an ideaspace may hold a
 *   real folder named "build". `.gitignore` is the correct fix, deferred.
 * - Symlinked entries are omitted (Dirent.is{Directory,File}() are false for a
 *   symlink) — which also keeps the walk cycle-safe.
 * - The scan cap bounds the walk before query filtering, so on a tree larger
 *   than the cap a matching entry past it is missed; callers should heed
 *   `truncated`.
 */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { AUTOCOMPLETE_EXCLUDES } from "./catalog.js";

export type EntryKind = "file" | "folder" | "code-repo" | "ideaspace-repo";

export interface FileEntry {
  /** Path relative to the walk root (POSIX-style forward slashes for stable @tokens). */
  path: string;
  /** Basename — what the autocomplete row shows. */
  name: string;
  kind: EntryKind;
}

export interface ListResult {
  entries: FileEntry[];
  /** True when the scan hit its cap and some entries were not visited. */
  truncated: boolean;
}

const EXCLUDES = new Set(AUTOCOMPLETE_EXCLUDES);

// Scan/return bounds. The scan cap keeps a pathological tree cheap; the depth cap
// keeps deeply-nested vendored trees from dominating. Generous enough that a
// normal workspace is fully covered.
const DEFAULT_MAX_SCAN = 5000;
const DEFAULT_MAX_DEPTH = 10;

export interface ListOptions {
  maxScan?: number;
  maxDepth?: number;
}

// A directory's kind: an ideaspace repo (`_agent/`) first — it is also a git repo,
// but the ideaspace framing is the more specific, more useful signal — then a
// plain code repo (`.git`), else an ordinary folder.
function folderKind(abs: string): Exclude<EntryKind, "file"> {
  if (existsSync(join(abs, "_agent"))) return "ideaspace-repo";
  if (existsSync(join(abs, ".git"))) return "code-repo";
  return "folder";
}

// Forward-slash the relative path so @tokens are stable across platforms.
function toPosix(rel: string): string {
  return rel.split(/[\\/]/).join("/");
}

/**
 * Breadth-first walk from `root`. Shallow entries (more likely relevant) come
 * first, so when the scan cap truncates, the closest files survive.
 */
export function listEntries(root: string, opts: ListOptions = {}): ListResult {
  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const entries: FileEntry[] = [];
  // A cursor over a growing array, not Array.shift() — shift() is O(n) per call
  // (O(n²) over a wide directory queue); an index advance is O(1).
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
  for (let head = 0; head < queue.length; head++) {
    const { abs, depth } = queue[head];
    let dirents: Dirent[];
    try {
      dirents = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (permissions, race) — skip, don't abort
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      // Dot-entries (.DS_Store, .gitignore, .git, …) are noise for a mention
      // picker; `_agent` is not dotted, so ideaspace markers survive.
      if (dirent.name.startsWith(".") || EXCLUDES.has(dirent.name)) continue;
      if (entries.length >= maxScan) return { entries, truncated: true };

      const childAbs = join(abs, dirent.name);
      const path = toPosix(relative(root, childAbs));
      if (dirent.isDirectory()) {
        entries.push({ path, name: dirent.name, kind: folderKind(childAbs) });
        if (depth + 1 <= maxDepth) queue.push({ abs: childAbs, depth: depth + 1 });
      } else if (dirent.isFile()) {
        entries.push({ path, name: dirent.name, kind: "file" });
      }
    }
  }
  return { entries, truncated: false };
}

// Rank a query against an entry: exact name > name-prefix > name-substring >
// path-substring. Non-matches score 0 and are dropped. Case-insensitive.
function scoreEntry(entry: FileEntry, query: string): number {
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  if (path.includes(query)) return 40;
  return 0;
}

/**
 * Filter+rank a scanned listing by a query and cap to `limit`. An empty query
 * returns the listing head (already shallow-first from the BFS walk).
 */
export function filterEntries(entries: FileEntry[], query: string, limit: number): FileEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const scored: Array<{ entry: FileEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, q);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  return scored.slice(0, limit).map((s) => s.entry);
}

// Exported for the command's text rendering and tests.
export function entryLabel(entry: FileEntry): string {
  const tag =
    entry.kind === "ideaspace-repo"
      ? " (ideaspace)"
      : entry.kind === "code-repo"
        ? " (repo)"
        : entry.kind === "folder"
          ? "/"
          : "";
  return `${entry.path}${tag}`;
}
