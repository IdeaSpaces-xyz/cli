/**
 * The display copy of a local Thread: every word a writer chose, on one line, made once.
 *
 * A post file is whatever its writer put in it. `threads open` prints an author, a name, a summary, tags,
 * reply ids, mark authors and a Thread's own name into lines an agent reads, and a line break in any of
 * them would let that field write the next line (`FORGED msg_x claimed by The human`). Cleaning each print
 * site one at a time left the next site open every review, so the cleaning is here and the print sites
 * are given only this copy: `displayThread` is applied once, right after a Thread is loaded for a read,
 * and the code that prints holds no raw field.
 *
 * Matching and the reader's seen cursor never use this copy. `threads open` keeps the Thread as written for `--ack`,
 * `--new`, `--since` and `--post`, so what is written to disk names the real ids, and prints only from this copy.
 *
 * What stays as written, on purpose:
 * - a post's `body`, which is its text and is shown as the body;
 * - `--post` and a pinned read, which print the file exactly as it is, frontmatter included;
 * - the Thread's README and Agreement prose, shown under their own labels (`Current frame:`, `Goal:`);
 * - paths: a post's `path`, a Thread's, a parent's or a child Thread's `path` and `unreadable_posts` name files on disk and stay
 *   exact so they still match them; text that prints one runs it through `singleLine` first.
 * Every other field of a post is cleaned by `deepLine`, whatever it is called, warnings included.
 * Ids are reduced like any other word, for printing only. An id with a control character in it is not a real id, and
 * the copy no longer matches the file, which is why nothing is matched or acknowledged against the copy.
 */
import type { ThreadPost } from "@ideaspaces/protocol";
import { singleLine } from "./claims.js";
import type { LocalThread } from "./threads.js";

const NO_CUT = Number.MAX_SAFE_INTEGER;

/** Object keys whose values name files on disk (`path` of a post, a parent or a child Thread) and stay exactly as they are. */
const RAW_KEYS: ReadonlySet<string> = new Set(["path", "unreadable_posts"]);

/**
 * Every string inside a value reduced to one line; numbers, booleans and null pass through. No field is cut:
 * line breaks and control characters become a space, runs of spaces collapse and the ends are trimmed, so the JSON a
 * tool reads keeps a name or a summary whole but for its whitespace. The print sites clip for their own width.
 * Only values are cleaned, never object keys: a print site must not interpolate a frontmatter key.
 */
export function deepLine<T>(value: T, max = NO_CUT): T {
  if (typeof value === "string") return singleLine(value, max) as T;
  if (Array.isArray(value)) return value.map((item) => deepLine(item, max)) as T;
  if (value && typeof value === "object") {
    // A path names a file on disk and must keep matching it: it is data for a tool, never printed into a line of text as it is.
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, RAW_KEYS.has(key) ? item : deepLine(item, max)])) as T;
  }
  return value;
}

export function displayPost(post: ThreadPost): ThreadPost {
  // Structure, not a list of fields: everything but the body and the file's path is cleaned, so a field the protocol adds
  // later (or a warning quoting one) cannot print raw. The body is the post's text; the path names the file on disk.
  const { body, path, ...rest } = post;
  const clean = deepLine(rest) as Omit<ThreadPost, "body" | "path">;
  // The protocol types `tags` as a list but does not check it, and a writer can give a string; a print site that joins it would crash
  // the whole read of the Thread. The display copy always holds a list.
  const tags = (clean.frontmatter as { tags?: unknown }).tags;
  if (tags !== undefined && !Array.isArray(tags)) (clean.frontmatter as { tags?: unknown }).tags = typeof tags === "string" ? [tags] : [];
  return { ...clean, body, path } as ThreadPost;
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
    // File names, kept as they are so they still match the files; they are only ever printed through `singleLine`.
    unreadablePosts: thread.unreadablePosts,
  };
}
