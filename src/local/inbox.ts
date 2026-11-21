/**
 * `threads inbox`: one read of what waits for a reader in this Space's Threads.
 *
 * - **Asks:** posts whose `to` (protocol #96) names one of the reader's names, not written by one of them,
 *   with no later post of theirs that replies to it, and not yet read by this reader (`threads ack`).
 * - **Moved:** the Threads that moved since this reader's held position, as `threads recent --reader`
 *   reads them (a reader's first look stores a baseline), each with its newest post.
 *
 * Names are claims, compared exactly and never resolved, as the protocol says. Nothing is written here
 * except the baseline `threads recent` stores on a reader's first look; no post is marked read.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadThread, readCursor, type LocalThread } from "./threads.js";
import { recentForReader, type MovedThread } from "./thread-recent.js";

/** How much of each post file is read to find a `to:` line before a Thread is loaded whole. */
const HEAD_BYTES = 8192;
/** How much of an ask's body a row shows. */
export const EXCERPT_CHARS = 280;

export interface InboxAsk {
  thread: string; slug: string; thread_name: string;
  post: { id: string; date: string | null; author: string | null; name?: string; summary?: string; excerpt: string };
  to: string[];
  /** The reader's names this post names, in the post's order. */
  matched: string[];
}

export interface InboxMoved extends MovedThread {
  path: string; name: string;
  newest?: { id: string; date: string | null; author: string | null; name?: string };
}

export interface InboxResult {
  asks: InboxAsk[];
  moved: { baseline: boolean; threads: InboxMoved[]; moved: number; cursor: string };
  /** Threads that couldn't be read: they may hold an ask that isn't listed. */
  warnings: string[];
}

/** Whether any post file of this Thread has a `to:` line in its frontmatter: only those are loaded whole. */
function mayAsk(dir: string): boolean {
  const buffer = Buffer.alloc(HEAD_BYTES);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, entry.name), "r");
      const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
      const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(buffer.toString("utf8", 0, read))?.[1];
      if (head === undefined || /^to:/m.test(head)) return true; // a header past the bytes read: load it to be sure
    } catch { return true; } finally { if (fd !== undefined) closeSync(fd); }
  }
  return false;
}

const plain = (body: string) => {
  const text = body.replace(/\s+/g, " ").trim();
  return [...text].length > EXCERPT_CHARS ? `${[...text].slice(0, EXCERPT_CHARS - 1).join("").trimEnd()}…` : text;
};

/** The asks one Thread holds for these names and this reader, oldest first. */
export function threadAsks(thread: LocalThread, names: ReadonlySet<string>, reader: string): InboxAsk[] {
  const seen = readCursor(thread, reader);
  const mine = (post: { frontmatter: { author?: string } }) => !!post.frontmatter.author && names.has(post.frontmatter.author);
  const answered = new Set(thread.posts.filter(mine).flatMap((post) => post.inReplyTo));
  return thread.posts.flatMap((post) => {
    const matched = (post.to ?? []).filter((name) => names.has(name));
    if (!matched.length || mine(post) || answered.has(post.id) || seen.has(post.id)) return [];
    return [{ thread: thread.path, slug: thread.slug, thread_name: thread.name,
      post: { id: post.id, date: post.date ?? null, author: post.frontmatter.author ?? null,
        ...(post.frontmatter.name ? { name: post.frontmatter.name } : {}), ...(post.frontmatter.summary ? { summary: post.frontmatter.summary } : {}),
        excerpt: plain(post.body) },
      to: post.to!, matched }];
  });
}

export function readInbox(root: string, threadsDir: string, names: readonly string[], reader: string, limit = 50): InboxResult {
  const wanted = new Set(names);
  const warnings: string[] = [];
  const asks: InboxAsk[] = [];
  const slugs = existsSync(threadsDir) ? readdirSync(threadsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name) : [];
  for (const slug of slugs) {
    const dir = join(threadsDir, slug);
    try {
      if (!mayAsk(dir)) continue;
      asks.push(...threadAsks(loadThread(dir), wanted, reader));
    } catch (error) {
      warnings.push(`Thread ${slug} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  asks.sort((a, b) => (a.post.date ?? "").localeCompare(b.post.date ?? "") || a.post.id.localeCompare(b.post.id));
  const recent = recentForReader(root, threadsDir, reader, limit);
  const threads = recent.threads.map((row): InboxMoved => {
    const path = join(threadsDir, row.slug);
    try {
      const thread = loadThread(path);
      const newest = thread.posts.at(-1);
      return { ...row, path: thread.path, name: thread.name,
        ...(newest ? { newest: { id: newest.id, date: newest.date ?? null, author: newest.frontmatter.author ?? null, ...(newest.frontmatter.name ? { name: newest.frontmatter.name } : {}) } } : {}) };
    } catch (error) {
      warnings.push(`Thread ${row.slug} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      return { ...row, path, name: row.slug };
    }
  });
  return { asks, moved: { baseline: recent.baseline, threads, moved: recent.moved, cursor: recent.cursor }, warnings };
}
