/**
 * Append one entry to a folder that keeps time by its Agreement (`keeps_time: true`), protocol
 * 0.33.0. A Thread's writer is `appendPost` in threads.ts; this is the same writer for every other
 * time-keeping folder: an immutable Markdown file with an id, a date and a kind, that may set the
 * folder's state (`parent`, `about`, `closed`, a Map) or supersede an entry. Files without an id in
 * such a folder are Notes and are never touched.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { inspectEntries, parseEntry, parseThreadAttachment, type Entry, type EntrySource, type ThreadKind } from "@ideaspaces/protocol";
import { folderKeeping, folderPosition } from "./folder-state.js";
import { parentReference, validateAddressees, validateMarkOptions, validateTags, validateThreadMomentMap } from "./threads.js";

export { folderPosition };

const MAX_ENTRY = 1024 * 1024;

export interface AppendEntryOptions {
  body: string;
  name?: string;
  summary?: string;
  author?: string;
  /** Parent entry ids in this folder; a full id or a unique eight-hex `msg_` short form. No default: an entry in a declared folder stands alone unless it answers one. */
  replyTo?: string[];
  kind?: ThreadKind;
  mark?: string;
  supersedes?: string;
  map?: unknown;
  tags?: string[];
  /** Who the entry asks (`to`), checked by `validateAddressees`. */
  to?: string[];
  parent?: string;
  about?: string[];
  closed?: boolean;
  rejectEscapedNewlines?: boolean;
}

function sources(dir: string, position: string): EntrySource[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md" && !entry.name.startsWith("."))
    .map((entry) => entry.name).sort()
    .map((name) => ({ path: `${position}/${name}`, content: readFileSync(join(dir, name), "utf8") }));
}

export function appendEntry(dir: string, options: AppendEntryOptions): { post: Entry; path: string; position: string } {
  const keeping = folderKeeping(dir);
  if (keeping === "placement") throw new Error("A Thread is written with threads post; this writer is for a folder that keeps time by its Agreement.");
  if (keeping !== "agreement") throw new Error(`${dir} keeps no time: its Agreement does not say keeps_time: true. Write a Note there with ideaspaces write, or turn time on in its _agent/agreement.md.`);
  const position = folderPosition(dir);
  const inspection = inspectEntries(sources(dir, position), { keeping: "agreement", folder: position });
  if (inspection.writeRefusal) throw new Error(inspection.writeRefusal);
  // A closed folder takes one kind of entry: the one that reopens it (closed: false), protocol 0.33.0.
  if (inspection.closed === true && options.closed !== false) throw new Error(`${position} is closed (entry ${inspection.closedPost?.id ?? "unknown"} set closed: true); append --closed false first to reopen it, or write elsewhere.`);
  if (!options.body.trim()) throw new Error("An entry needs a body, through --message or stdin.");
  if (options.rejectEscapedNewlines && !options.body.includes("\n") && (options.body.match(/\\n/g) ?? []).length >= 2) {
    throw new Error("--message contains repeated literal \\n sequences. Pass real newlines (for example Bash $'first\\nsecond'); to post literal escapes intentionally, pipe the body on stdin instead.");
  }
  if (Buffer.byteLength(options.body) > MAX_ENTRY) throw new Error(`Entry body exceeds ${MAX_ENTRY} bytes.`);
  for (const value of [options.name, options.summary, options.author]) {
    if (value && (/[\r\n]/.test(value) || value.length > 1000)) throw new Error("Entry header values must be single-line and at most 1,000 characters.");
  }
  if (options.tags !== undefined) validateTags(options.tags);
  const to = options.to === undefined ? undefined : validateAddressees(options.to);
  validateMarkOptions(options.kind, options.mark, options.replyTo);
  if (options.parent !== undefined) parentReference(options.parent);
  for (const link of options.about ?? []) {
    if (!link.includes(":") || !parseThreadAttachment(link)) throw new Error(`--about links are <type>:<id>, not ${link}. Nothing written.`);
  }
  const requestedKind: ThreadKind = options.kind ?? "post";
  const kind: ThreadKind = requestedKind === "snapshot" ? "post" : requestedKind;
  const closed = options.closed ?? (requestedKind === "closure" ? true : undefined);
  const byId = new Map(inspection.posts.map((post) => [post.id, post]));
  const parentIds = (options.replyTo ?? []).map((id) => {
    if (byId.has(id) || !/^msg_[0-9a-f]{8}$/.test(id)) return id;
    const matches = inspection.posts.filter((post) => post.id.startsWith(`${id}-`));
    if (matches.length > 1) throw new Error(`--reply-to ${id} matches ${matches.length} entries: ${matches.map((post) => post.id).join(", ")}. Give the full id; nothing written.`);
    return matches[0]?.id ?? id;
  });
  if (new Set(parentIds).size !== parentIds.length || parentIds.some((id) => !byId.has(id))) throw new Error(`--reply-to must name distinct existing entry ids in ${position}.`);
  if (requestedKind === "correction" && (!options.supersedes || !byId.has(options.supersedes))) throw new Error("A correction requires --supersedes <existing entry id>.");
  if (options.supersedes && requestedKind !== "correction") throw new Error("--supersedes requires --kind correction.");
  if (requestedKind === "snapshot" && options.map === undefined) throw new Error("A snapshot requires a Map. Add --map <note>; no entry written.");
  if (options.map !== undefined) validateThreadMomentMap(options.map);
  const parents = parentIds.map((id) => byId.get(id)!);
  const references = [...new Set(parents.flatMap((parent) => [...parent.references, parent.id]))];
  const id = `msg_${randomUUID()}`;
  const date = new Date().toISOString();
  const file = `${date.replace(/[:.]/g, "-")}-${id}.md`;
  const fields = {
    id, date, kind, ...(options.mark ? { mark: options.mark } : {}),
    ...(closed !== undefined ? { closed } : {}),
    ...(options.parent !== undefined ? { parent: options.parent } : {}),
    ...(options.about !== undefined ? { about: options.about } : {}),
    ...(parentIds.length ? { in_reply_to: parentIds.length === 1 ? parentIds[0] : parentIds } : {}),
    ...(references.length ? { references } : {}),
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
    ...(options.name ? { name: options.name } : {}), ...(options.summary ? { summary: options.summary } : {}),
    ...(options.tags && options.tags.length ? { tags: [...new Set(options.tags)] } : {}),
    ...(to ? { to: to.length === 1 ? to[0] : to } : {}),
    ...(options.author ? { author: options.author } : {}), ...(options.map !== undefined ? { map: options.map } : {}),
  };
  const content = `---\n${stringify(fields)}---\n\n${options.body.trim()}\n`;
  const parsed = parseEntry(content, `${position}/${file}`, { keeping: "agreement" });
  if (parsed.status !== "valid") throw new Error(`Generated entry failed validation before write: ${parsed.status === "invalid" ? parsed.issues.join(", ") : parsed.status}`);
  if (parsed.post.warnings?.length) throw new Error(`Generated entry failed validation before write: ${parsed.post.warnings.map((w) => `${w.field}: ${w.warning}`).join(", ")}`);
  const path = join(dir, file);
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  return { post: parsed.post, path, position };
}
