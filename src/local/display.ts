/**
 * The display copy of a local Thread: every word a writer chose, on one line, made once.
 *
 * A post file is whatever its writer put in it. `threads open` prints an author, a name, a summary, tags,
 * reply ids, mark authors and a Thread's own name into lines an agent reads, and a line break in any of
 * them would let that field write the next line (`FORGED msg_x claimed by The human`). Cleaning each print
 * site one at a time left the next site open every review, so the cleaning is here and the print sites
 * are given only this copy: `displayThread` is applied once, right after a Thread is loaded for a read,
 * and nothing downstream holds the raw field.
 *
 * What stays as written, on purpose:
 * - a post's `body`, which is its text and is shown as the body;
 * - `--post` and a pinned read, which print the file exactly as it is, frontmatter included;
 * - the Thread's README and Agreement prose, shown under their own labels (`Current frame:`, `Goal:`);
 * - a post's `path`, which names the file on disk and is never printed into a line of text.
 * Ids are reduced like any other word. An id with a control character in it is not a real id, and the
 * copy no longer matches the file; the read still works, and a cursor for it would simply be new.
 */
import type { ThreadPost } from "@ideaspaces/protocol";
import { singleLine } from "./claims.js";
import type { LocalThread } from "./threads.js";

const NO_CUT = Number.MAX_SAFE_INTEGER;

/** Every string inside a value reduced to one line; numbers, booleans and null pass through. */
/** No field is cut: only its line breaks go, so the JSON a tool reads keeps every character of a name or a summary. The print sites clip for their own width. */
export function deepLine<T>(value: T, max = NO_CUT): T {
  if (typeof value === "string") return singleLine(value, max) as T;
  if (Array.isArray(value)) return value.map((item) => deepLine(item, max)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deepLine(item, max)])) as T;
  }
  return value;
}

export function displayPost(post: ThreadPost): ThreadPost {
  const frontmatter = Object.fromEntries(Object.entries(post.frontmatter).map(([key, item]) => [key, deepLine(item)])) as ThreadPost["frontmatter"];
  return {
    ...post,
    id: singleLine(post.id, NO_CUT),
    ...(post.date !== undefined ? { date: singleLine(post.date, NO_CUT) } : {}),
    kind: singleLine(post.kind, NO_CUT),
    ...(post.mark !== undefined ? { mark: singleLine(post.mark, NO_CUT) } : {}),
    ...(post.supersedes !== undefined ? { supersedes: singleLine(post.supersedes, NO_CUT) } : {}),
    frontmatter,
    inReplyTo: post.inReplyTo.map((id) => singleLine(id, NO_CUT)),
    references: post.references.map((id) => singleLine(id, NO_CUT)),
    ...(post.marks ? { marks: post.marks.map((mark) => ({ ...mark, id: singleLine(mark.id, NO_CUT), mark: singleLine(mark.mark, NO_CUT), author: singleLine(mark.author, NO_CUT) })) } : {}),
  };
}

/** A Thread read for display: its posts, names and diagnostics as single lines. Logic that must match files by id or path should use the raw Thread. */
export function displayThread(thread: LocalThread): LocalThread {
  return {
    ...thread,
    slug: singleLine(thread.slug, NO_CUT),
    thread_id: thread.thread_id === null ? null : singleLine(thread.thread_id, NO_CUT),
    name: singleLine(thread.name, NO_CUT),
    summary: singleLine(thread.summary, NO_CUT),
    posts: thread.posts.map(displayPost),
    allPosts: thread.allPosts.map(displayPost),
    warnings: thread.warnings.map((warning) => singleLine(warning, NO_CUT)),
    unreadablePosts: thread.unreadablePosts.map((path) => singleLine(path, NO_CUT)),
  };
}
