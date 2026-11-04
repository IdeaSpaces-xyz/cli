/**
 * What moved across one Space's local Threads, by the set of post files, never a time stamp: a
 * merge can bring in a post dated before a reader's last look, and a stamp would lose it.
 *
 * A position is one record per Thread: a key for its folder, its post count, and an XOR of its
 * filenames' hashes. That is an order-free fingerprint of the set, so it fits in a cursor an agent
 * can hold, at about 19 characters a Thread, and any added or removed post changes it. It can say
 * which Threads moved and by how many, not which posts; a reader then opens those Threads.
 *
 * Filenames alone are enough because a post file is immutable, and reading them is what keeps this
 * call fast: no post is parsed. Nothing here touches a reader's per-Thread seen set, so it can
 * never change what anyone's `--new` shows.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = 1;
const KEY_BYTES = 6;
const RECORD_BYTES = KEY_BYTES + 8;
const HEADER_BYTES = 5;

export interface MovedThread {
  slug: string;
  new_posts: number;
  /** Posts left or were replaced, so a count alone would hide that the set moved. */
  changed?: true;
  /** No record of this Thread at the position: every post in it is new to this reader. */
  new_thread?: true;
}

interface Fingerprint { key: string; count: number; set: string }
const sha = (text: string) => createHash("sha256").update(text).digest();

function fingerprint(slug: string, files: string[]): Fingerprint {
  const set = Buffer.alloc(6);
  for (const file of files) {
    const hash = sha(file);
    for (let i = 0; i < 6; i++) set[i] ^= hash[i];
  }
  return { key: sha(slug).subarray(0, KEY_BYTES).toString("hex"), count: Math.min(files.length, 0xffff), set: set.toString("hex") };
}

function current(threadsDir: string): Array<Fingerprint & { slug: string }> {
  if (!existsSync(threadsDir)) return [];
  return readdirSync(threadsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const files = readdirSync(join(threadsDir, entry.name), { withFileTypes: true })
        .filter((file) => file.isFile() && file.name.endsWith(".md") && file.name !== "README.md")
        .map((file) => file.name);
      return { slug: entry.name, ...fingerprint(entry.name, files) };
    });
}

function encode(root: string, threads: Fingerprint[]): string {
  const bytes = Buffer.alloc(HEADER_BYTES + threads.length * RECORD_BYTES);
  bytes[0] = VERSION;
  sha(root).copy(bytes, 1, 0, 4);
  threads.forEach((thread, index) => {
    const at = HEADER_BYTES + index * RECORD_BYTES;
    Buffer.from(thread.key, "hex").copy(bytes, at);
    bytes.writeUInt16BE(thread.count, at + KEY_BYTES);
    Buffer.from(thread.set, "hex").copy(bytes, at + KEY_BYTES + 2);
  });
  return bytes.toString("base64url");
}

function decode(root: string, cursor: string): Map<string, Fingerprint> {
  const bytes = Buffer.from(cursor, "base64url");
  if (bytes.length < HEADER_BYTES || bytes[0] !== VERSION || (bytes.length - HEADER_BYTES) % RECORD_BYTES) {
    throw new Error("That is not a cursor from threads recent. Run threads recent with no --cursor for a new baseline.");
  }
  if (!sha(root).subarray(0, 4).equals(bytes.subarray(1, HEADER_BYTES))) {
    throw new Error("That cursor is from another Space or checkout. Run threads recent here with no --cursor for a new baseline.");
  }
  const threads = new Map<string, Fingerprint>();
  for (let at = HEADER_BYTES; at < bytes.length; at += RECORD_BYTES) {
    const key = bytes.subarray(at, at + KEY_BYTES).toString("hex");
    threads.set(key, { key, count: bytes.readUInt16BE(at + KEY_BYTES), set: bytes.subarray(at + KEY_BYTES + 2, at + RECORD_BYTES).toString("hex") });
  }
  return threads;
}

function moved(threads: ReturnType<typeof current>, position: Map<string, Fingerprint>): MovedThread[] {
  const rows: MovedThread[] = [];
  for (const thread of threads) {
    const seen = position.get(thread.key);
    if (!seen) rows.push({ slug: thread.slug, new_posts: thread.count, new_thread: true });
    else if (seen.set !== thread.set) {
      const added = thread.count - seen.count;
      rows.push({ slug: thread.slug, new_posts: Math.max(added, 0), ...(added <= 0 ? { changed: true as const } : {}) });
    }
  }
  return rows.sort((a, b) => b.new_posts - a.new_posts || a.slug.localeCompare(b.slug));
}

export interface RecentResult {
  /** True when this reader had no position: nothing is new, and `cursor` is where it starts. */
  baseline: boolean;
  /** The Threads to show, at most the limit asked for. */
  threads: MovedThread[];
  /** How many moved in all; more than `threads.length` means the rest wait for the next read. */
  moved: number;
  /** Covers only what was shown: passing it on never marks an unshown Thread as seen. */
  cursor: string;
}

/** Read only. The caller holds the cursor it gets back and passes it next time. */
export function recentSince(root: string, threadsDir: string, cursor?: string, limit = Infinity): RecentResult {
  const threads = current(threadsDir);
  if (cursor === undefined) return { baseline: true, threads: [], moved: 0, cursor: encode(root, threads) };
  const position = decode(root, cursor);
  const rows = moved(threads, position);
  const unshown = new Set(rows.slice(limit).map((row) => row.slug));
  const next = threads.flatMap((thread) => {
    if (!unshown.has(thread.slug)) return [thread];
    const seen = position.get(thread.key);
    return seen ? [seen] : [];
  });
  return { baseline: false, threads: rows.slice(0, limit), moved: rows.length, cursor: encode(root, next) };
}

const READER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PERSON_READER = "person";

/**
 * The reader whose position applies: the flag, then what the host named, then the person. Never
 * derived from the working directory: that folder is also a person's terminal.
 */
export function readerName(flag?: string, environment = process.env.IDEASPACES_READER): string {
  const reader = flag ?? (environment?.trim() || PERSON_READER);
  if (!READER.test(reader)) throw new Error(`Invalid reader ${JSON.stringify(reader)}: use 1 to 64 letters, digits, ., _ or -, starting with a letter or digit.`);
  return reader;
}

function readersDirectory(reader: string): string {
  const base = join(homedir(), ".ideaspaces", "cursors");
  for (const path of [base, join(base, "readers")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Refusing symlink local cursor directory.");
  }
  return join(base, "readers", reader);
}

/** Where a named reader's per-Thread seen sets live; the person keeps the original location. */
export function readerCursorDirectory(reader: string): string | undefined {
  return reader === PERSON_READER ? undefined : readersDirectory(reader);
}

function heldPath(root: string, reader: string): string {
  return join(readersDirectory(reader), `recent-${sha(root).subarray(0, 16).toString("hex")}.json`);
}

function hold(root: string, reader: string, cursor: string): void {
  const path = heldPath(root, reader);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ cursor }), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * What moved since this reader's held position. A first look sets the baseline, which hides
 * nothing because nothing had been shown as new. After that a look moves nothing; only
 * `threads ack --recent` does, so a failed session leaves the reader's position where it was.
 */
export function recentForReader(root: string, threadsDir: string, reader: string, limit = Infinity): RecentResult {
  const path = heldPath(root, reader);
  if (!existsSync(path)) {
    const baseline = recentSince(root, threadsDir);
    hold(root, reader, baseline.cursor);
    return baseline;
  }
  const invalid = new Error(`Invalid held position: ${path}. Delete it for a new baseline.`);
  let held: unknown;
  try { held = JSON.parse(readFileSync(path, "utf8")); } catch { throw invalid; }
  if (!held || typeof held !== "object" || typeof (held as { cursor?: unknown }).cursor !== "string") throw invalid;
  return recentSince(root, threadsDir, (held as { cursor: string }).cursor, limit);
}

/** Move a reader's held position to a cursor `threads recent` returned here. */
export function acknowledgeRecent(root: string, reader: string, cursor: string): void {
  decode(root, cursor);
  hold(root, reader, cursor);
}
