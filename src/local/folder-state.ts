/**
 * The state of a folder that keeps time (protocol 0.33.0, time.md): what its entries have set.
 *
 * A Thread keeps time by placement (`_threads/<thread>/`); any other folder keeps time when its own
 * Agreement says `keeps_time: true`. For both, the current value of a field is the newest readable
 * entry that carries it: `name` and `summary` (a reframe's; for a Thread, else the opening's),
 * `parent`, `about`, `closed`, and the current Map. `--as-of` reads the state as it stood at a
 * cursor: entries after it set nothing. Read-only; the protocol does the deriving.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  currentMap, inspectEntries, parseEntry, parseFrontmatter, readsTime, selectEntries,
  type CurrentMap, type Entry, type EntrySource, type TimeCursor, type TimeKeeping,
} from "@ideaspaces/protocol";
import { repoRoot } from "../git.js";
import { attachmentText, loadThread, parseTimeCursor, type LocalThread } from "./threads.js";

export interface FolderState {
  keeping: TimeKeeping;
  /** The folder's repository-relative position. */
  position: string;
  name: string | null;
  /** Where `name` came from; a declared folder has no fallback, so only `reframe` or absent. */
  name_source?: "reframe" | "opening" | "readme";
  summary: string | null;
  parent: { value: string; source: "post" | "agreement" | "origin" | null; post?: string; origin?: string } | "unknown" | null;
  about: string[];
  closed: boolean | "unknown";
  closed_post?: string;
  current_map: { status: "post" | "opening" | "none"; post: string | null; kind?: string; members: number; reason?: string };
  entries: number;
  /** A declared folder's direct files with no `id`: ordinary Notes, outside the timeline. */
  notes: number;
  unreadable: string[];
  superseded: string[];
  warnings: string[];
  /** Present when read as of a cursor: how many entries after it were left out of the reading. */
  as_of?: { cursor: string; excluded: number };
}

/** How a folder keeps time, or null when it does not. Never reads anything but the folder's own Agreement. */
export function folderKeeping(dir: string): TimeKeeping | null {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return null;
  if (basename(dirname(dir)) === "_threads") return "placement";
  const agreement = join(dir, "_agent", "agreement.md");
  if (!existsSync(agreement)) return null;
  try {
    return readsTime(parseFrontmatter(readFileSync(agreement, "utf8"))).keeps ? "agreement" : null;
  } catch {
    return null;
  }
}

function portablePosition(dir: string): string {
  try {
    return relative(repoRoot(dir), dir).split("\\").join("/") || ".";
  } catch {
    return basename(dir);
  }
}

/** A declared folder's direct Markdown files (not README.md, not dotfiles), as entry sources. */
function declaredSources(dir: string, position: string): EntrySource[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md" && !entry.name.startsWith("."))
    .map((entry) => entry.name).sort()
    .map((name) => ({ path: `${position}/${name}`, content: readFileSync(join(dir, name), "utf8") }));
}

/** The entry filenames kept as of a cursor, for a page filter; throws when the cursor resolves to nothing. */
export function entriesAsOf(dir: string, asOf: TimeCursor): Set<string> {
  const keeping = folderKeeping(dir);
  if (!keeping) throw new Error(`${dir} keeps no time (not a Thread, and its Agreement does not say keeps_time: true); --as-of reads a folder that keeps time. For a commit, use --pin.`);
  const position = keeping === "placement" ? `_threads/${basename(dir)}` : portablePosition(dir);
  const sources = declaredSources(dir, position);
  const entries: Entry[] = sources.flatMap((source) => { const result = parseEntry(source.content, source.path, { keeping }); return result.status === "valid" ? [result.post] : []; });
  const cursor: TimeCursor = "path" in asOf ? { path: asOf.path.includes("/") ? asOf.path : `${position}/${asOf.path}` } : asOf;
  const selection = selectEntries(entries, { asOf: cursor });
  if (selection.status !== "ok") throw new Error(`--as-of ${JSON.stringify(Object.values(asOf)[0])} is ${selection.status} in ${position}: ${selection.reason}`);
  return new Set(selection.entries.map((entry) => basename(entry.path)));
}

/** Resolve a `--since` value to the child filename content-look pages from: a filename as is; an id by its entry; a moment by the newest entry at or before it. */
export function sinceCursorFile(dir: string, since: string): string | undefined {
  if (since.endsWith(".md")) return since;
  const keeping = folderKeeping(dir);
  if (!keeping) throw new Error(`--since ${since} is not a child filename, and ${dir} keeps no time, so it cannot be an entry id or a moment. Pass the previous page's nextCursor.`);
  const position = keeping === "placement" ? `_threads/${basename(dir)}` : portablePosition(dir);
  const entries: Entry[] = declaredSources(dir, position).flatMap((source) => { const result = parseEntry(source.content, source.path, { keeping }); return result.status === "valid" ? [result.post] : []; });
  const cursor = parseTimeCursor(since);
  if ("at" in cursor) {
    // since a moment lists the entries after it: page from the newest entry at or before the moment.
    const selection = selectEntries(entries, { asOf: cursor });
    if (selection.status !== "ok") throw new Error(`--since ${since}: ${selection.reason}`);
    const last = selection.entries.at(-1);
    return last ? basename(last.path) : undefined;
  }
  if ("path" in cursor) return basename(cursor.path);
  const id = cursor.id;
  const match = entries.find((entry) => entry.id === id || entry.id.startsWith(`${id}-`));
  if (!match) throw new Error(`--since ${since} names no entry in ${position}. Give an entry id, an ISO date, or the previous page's nextCursor.`);
  return basename(match.path);
}

function mapState(current: CurrentMap): FolderState["current_map"] {
  return {
    status: current.status, post: current.post?.id ?? null,
    ...(current.post ? { kind: current.post.kind } : {}),
    members: current.map?.members.length ?? 0,
    ...(current.reason ? { reason: current.reason } : {}),
  };
}

function threadState(dir: string, asOf?: TimeCursor): FolderState {
  const thread: LocalThread = loadThread(dir, asOf ? { asOf } : {});
  const direct = readdirSync(dir).filter((name) => name.endsWith(".md") && name !== "README.md" && !name.startsWith(".")).length;
  const parent = thread.attachment === "unknown" ? "unknown" : thread.attachment === null ? null : {
    value: attachmentText(thread.attachment), source: thread.parentSource,
    ...(thread.origin && thread.origin !== "unknown" && attachmentText(thread.origin) !== attachmentText(thread.attachment) ? { origin: attachmentText(thread.origin) } : {}),
  };
  return {
    keeping: "placement", position: `_threads/${thread.slug}`,
    name: thread.name, name_source: thread.nameSource, summary: thread.summary,
    parent, about: thread.about.map(attachmentText), closed: thread.closed,
    current_map: mapState(thread.currentMap),
    entries: thread.allPosts.length, notes: 0, unreadable: thread.unreadablePosts,
    superseded: thread.allPosts.filter((post) => thread.allPosts.some((other) => other.kind === "correction" && other.supersedes === post.id)).map((post) => post.id),
    warnings: thread.warnings,
    ...(asOf ? { as_of: { cursor: String(Object.values(asOf)[0]), excluded: Math.max(0, direct - thread.allPosts.length - thread.unreadablePosts.length) } } : {}),
  };
}

function declaredState(dir: string, asOf?: TimeCursor): FolderState {
  const position = portablePosition(dir);
  const all = declaredSources(dir, position);
  const kept = asOf ? entriesAsOf(dir, asOf) : null;
  const sources = kept ? all.filter((source) => kept.has(basename(source.path)) || parseEntry(source.content, source.path, { keeping: "agreement" }).status === "note") : all;
  const inspection = inspectEntries(sources, { keeping: "agreement", folder: position });
  const current = currentMap(sources, { keeping: "agreement" });
  const parent = inspection.parent === "unknown" ? "unknown" : inspection.parent === null ? null
    : { value: attachmentText(inspection.parent), source: inspection.source, ...(inspection.parentPost ? { post: inspection.parentPost.id } : {}) };
  return {
    keeping: "agreement", position,
    name: inspection.name, ...(inspection.namePost ? { name_source: "reframe" as const } : {}), summary: inspection.summary,
    parent, about: inspection.about.map(attachmentText), closed: inspection.closed,
    ...(inspection.closedPost ? { closed_post: inspection.closedPost.id } : {}),
    current_map: mapState(current),
    entries: inspection.posts.length, notes: inspection.notes.length,
    unreadable: inspection.unreadable.map((entry) => entry.path), superseded: inspection.superseded,
    warnings: inspection.warnings.map((warning) => `${warning.post}: ${warning.field}: ${warning.warning}`),
    ...(asOf ? { as_of: { cursor: String(Object.values(asOf)[0]), excluded: all.length - sources.length } } : {}),
  };
}

/** The folder's state, or null when it keeps no time. */
export function folderState(dir: string, asOf?: TimeCursor): FolderState | null {
  const keeping = folderKeeping(dir);
  if (!keeping) return null;
  return keeping === "placement" ? threadState(dir, asOf) : declaredState(dir, asOf);
}

/** The state as text, before the protocol's own rendering of the folder. */
export function renderFolderState(state: FolderState): string {
  const what = state.keeping === "placement" ? "a Thread" : "a folder that keeps time (keeps_time: true)";
  const scope = state.as_of ? `; as of ${state.as_of.cursor}, ${state.as_of.excluded} later ${state.as_of.excluded === 1 ? "entry" : "entries"} left out` : "";
  const lines = [`State of ${state.position} (${what}${scope}):`];
  if (state.name !== null) lines.push(`  name: ${state.name}${state.name_source ? ` (from ${state.name_source === "reframe" ? "a reframe" : state.name_source === "opening" ? "the opening post" : "the README"})` : ""}`);
  if (state.summary !== null && state.summary !== "") lines.push(`  summary: ${state.summary.replace(/\s+/g, " ").slice(0, 400)}`);
  if (state.parent === "unknown") lines.push("  parent: unknown (the opening entry cannot be read)");
  else if (state.parent) lines.push(`  parent: ${state.parent.value}${state.parent.source ? ` (from ${state.parent.source === "post" ? "a post" : state.parent.source === "agreement" ? "the Agreement" : "the opening post"})` : ""}${state.parent.origin ? ` · origin: ${state.parent.origin}` : ""}`);
  if (state.about.length) lines.push(`  about: ${state.about.join(", ")}`);
  lines.push(`  closed: ${state.closed}${state.closed === "unknown" ? " (an entry newer than the one that settled it cannot be read)" : ""}`);
  const map = state.current_map;
  lines.push(`  current Map: ${map.status === "none" ? `none (${map.reason === "empty" ? "no entries yet" : map.reason === "opening_unknown" ? "the opening was not read" : "no entry carries one"})` : `${map.status === "opening" ? "the opening entry" : "entry"} ${map.post}${map.kind && map.kind !== "post" ? ` (${map.kind})` : ""} · ${map.members} member${map.members === 1 ? "" : "s"}`}`);
  lines.push(`  entries: ${state.entries}${state.keeping === "agreement" ? ` · notes: ${state.notes}` : ""}${state.unreadable.length ? ` · unreadable: ${state.unreadable.length}` : ""}${state.superseded.length ? ` · superseded: ${state.superseded.join(", ")}` : ""}`);
  return lines.join("\n");
}
