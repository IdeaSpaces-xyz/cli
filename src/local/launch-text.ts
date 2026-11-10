import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MapBlock, MapPositionMember } from "@ideaspaces/protocol";
import { validateAgentPov } from "./agent-pov.js";
import { findLaunchMap, firstThreadPostMember, memberMatches, noteCandidates, postsSince, renderLaunchFrame, type LaunchFrame, type NoteChoice } from "./launch-point.js";
import { loadMapNote } from "./map-note.js";
import {
  loadMapOrientation,
  MAP_ORIENTATION_BUDGET,
  MapBudgetError,
  type MapOrientationDropped,
  type MapOrientationLowered,
  type MapOrientationMerged,
  type MapOrientationResult,
} from "./map-orientation.js";
import { prepareThreadLaunch, type ThreadReadReceipt } from "./thread-launch.js";
import { loadThread, resolveLocalThread, threadBase } from "./threads.js";

/**
 * What a launch may add to a runtime's argv in bytes: the Map, the Agreement and the Thread frame
 * together. Both runtimes receive it through `--append-system-prompt`; the message is separate.
 */
export const MAX_ORIENTATION_BYTES = 16 * 1024;

/** The selected Agreement as `agent run` appends it, so the two routes cannot drift. */
export function renderPovOrientation(pov: { path: string; contractType: string }, contract: string): string {
  return `[Selected ${pov.contractType} POV: ${pov.path}]\n${contract}`;
}

/** The parts of one launch, in the order `agent run` appends them, and what each costs. */
export interface LaunchSizes {
  map: number;
  pov: number;
  frame: number;
  total: number;
}

export function launchSizes(parts: { map?: string; pov?: string; frame?: string }): LaunchSizes {
  const bytes = (text?: string) => (text ? Buffer.byteLength(text) : 0);
  const joined = [parts.map, parts.pov, parts.frame].filter(Boolean).join("\n\n");
  return { map: bytes(parts.map), pov: bytes(parts.pov), frame: bytes(parts.frame), total: Buffer.byteLength(joined) };
}

/**
 * A launch whose parts leave no room for the Map. Told apart from other failures by type, so the
 * wording can change without a caller losing the distinction.
 */
export class LaunchSizeError extends Error {
  constructor(message: string, readonly sizes: LaunchSizes) {
    super(message);
    this.name = "LaunchSizeError";
  }
}

/** The one refusal for a launch that does not fit, naming each part so the person can see what to shorten. */
export function launchSizeError(sizes: LaunchSizes): string | undefined {
  if (sizes.total <= MAX_ORIENTATION_BYTES) return undefined;
  const parts = [
    sizes.map ? `Map ${sizes.map}` : undefined,
    sizes.pov ? `Agreement ${sizes.pov}` : undefined,
    `Thread frame ${sizes.frame}`,
  ].filter(Boolean).join(", ");
  return `Combined ${sizes.map ? "Map, " : ""}Agreement and Thread orientation exceeds 16 KiB: ${sizes.total} bytes (${parts}). ` +
    `Shorten the Agreement or the post summary${sizes.map ? ", or lower the Map's declared depths" : ""}, then launch again.`;
}

/**
 * The launch Map, read so that the whole launch fits `MAX_ORIENTATION_BYTES`: the Map takes the room
 * the Agreement and the Thread frame leave, up to its own budget. When that is less than it needs,
 * members are lowered and then dropped, the last first, and the Map says which. A frame and Agreement
 * that do not fit alone throw `LaunchSizeError`, since no Map can help; a room too small for even a
 * pointer to the Map throws `MapBudgetError`.
 */
export async function loadLaunchMap(
  reference: string,
  context: string,
  parts: { pov?: string; frame: string; loadedAsNote?: MapBlock; budget?: number },
): Promise<MapOrientationResult> {
  const alone = launchSizes({ pov: parts.pov, frame: parts.frame });
  const refusal = launchSizeError(alone);
  if (refusal) throw new LaunchSizeError(refusal, alone);
  const room = MAX_ORIENTATION_BYTES - Buffer.byteLength([parts.pov, parts.frame].filter(Boolean).join("\n\n")) - 2;
  let limit = Math.min(parts.budget ?? MAP_ORIENTATION_BUDGET, room);
  // The budget counts characters and the cap counts bytes. A read that comes out over the room by `over`
  // bytes is read again with its character limit lowered by `over`: every byte over is at least one
  // character over, so the second read lands inside the room unless the Map's multi-byte share moved
  // between reads, which a different cut can do. Six is a bound that cannot be reached with real text.
  for (let attempt = 0; attempt < 6 && limit > 0; attempt++) {
    let loaded: MapOrientationResult;
    try {
      loaded = await loadMapOrientation(reference, context, { budget: limit, loadedAsNote: parts.loadedAsNote });
    } catch (error) {
      // Only a size failure is about the room; a Map that cannot be read says what it says.
      if (!(error instanceof MapBudgetError)) throw error;
      throw new MapBudgetError(`${error.message} The Agreement and the Thread frame leave ${room} of ${MAX_ORIENTATION_BYTES} bytes for the Map.`);
    }
    const over = Buffer.byteLength(loaded.text) - room;
    if (over <= 0) return loaded;
    limit = Math.min(limit, loaded.text.length) - over;
  }
  throw new MapBudgetError(`The Map does not fit in the ${room} of ${MAX_ORIENTATION_BYTES} bytes the Agreement and the Thread frame leave, not even as a pointer to it.`);
}

/** A Map member read at a lower depth than declared. */
export interface CutMember extends MapOrientationLowered {
  kind: "depth";
  reason: string;
}

/** A Map member left out because it did not fit even at name. */
export interface CutDropped extends MapOrientationDropped {
  kind: "dropped";
  reason: string;
}

export interface CutLegend {
  kind: "legend";
  reason: string;
}

/** Lines of "posts since the Map" the launch left out, the oldest first. */
export interface CutPosts {
  kind: "posts";
  omitted: number;
  reason: string;
}

/** The launch Thread's Agreement given as one line and where to read it, because it did not fit whole. */
export interface CutAgreement {
  kind: "agreement";
  path: string;
  reason: string;
}

export interface LaunchText {
  schema: "ideaspaces.threads.launch-text.v1";
  /** The assembled launch text: the Map, then the Agreement of the one who launches when one was given, then the Thread frame. */
  text: string;
  chars: number;
  bytes: number;
  max_bytes: number;
  /** The Thread the session is launched from: its Agreement, Map and later posts frame the launch. */
  thread: { slug: string; path: string };
  /** The post the session starts from. */
  post: { id: string; path: string };
  /** The post whose Map was read: the Thread's newest post that carries one, of any kind, else its opening post. */
  map_post: { id: string; path: string; kind: string; origin: "post" | "opening" };
  /** Posts written after the Map's post: how many, and how many the frame lists. */
  since: { total: number; listed: number };
  /** The post this launch loads whole, with its Thread pinned: a member of the Map. */
  note: { thread: string; post: string; member: number; by: NoteChoice; position: string; pin: string; closed: boolean | "unknown" };
  /** `agreement` is how the launch Thread's own Agreement went in: `whole`, `line` when the launch had no room, or `none`. */
  agreement: "whole" | "line" | "none";
  map: { budget: number; chars: number };
  /** The Map's own record of members read at a lower depth than declared. `cut` carries the same members, each with the reason and where to read it. */
  lowered: MapOrientationLowered[];
  /** Members the Map dropped to fit, the last first. */
  dropped: MapOrientationDropped[];
  /** Everything that did not arrive whole, so a reader can reach it: lowered and dropped members with their addresses and paths, a dropped legend, posts not listed, an Agreement given as a line. */
  cut: Array<CutMember | CutDropped | CutLegend | CutPosts | CutAgreement>;
  /** Members the Map left out because the same post is the Note. */
  merged: MapOrientationMerged[];
  receipt: ThreadReadReceipt;
}

export interface LaunchTextInput {
  /** The Thread the session starts from: a slug or a path. Its Agreement, newest Map and later posts frame the launch. */
  thread: string;
  /** The post the session starts from: any post of that Thread. The Map is the Thread's newest, not this post's. */
  post: string;
  /** Which member of the Map is the Note. Without it: this post, the Map's post, or the post either is attached to, when that is a member; else the Map's first post in a Thread (`note.by` says which). */
  member?: string;
  /** An agent folder whose Agreement goes in, as `agent run` does. */
  pov?: string;
  cwd?: string;
  /** The Map's own budget in characters. It can only lower the Map; the launch's cap is in bytes and still applies. */
  budget?: number;
}

const POST_ID = /^msg_[0-9a-f-]+$/;

function memberLine(map: MapBlock, index: number): string {
  const member = map.members[index] as { position?: string; address?: string; depth?: string };
  return `[${index}] ${member.position ?? member.address} (${member.depth ?? "summary"})`;
}

/**
 * The Note's ordinal: the one asked for, else the first member that is one of the candidate posts, else the
 * Map's first post in a Thread (a Map is authored in priority order). `by` says which, so a fallback is visible.
 */
function selectNote(map: MapBlock, candidates: Array<{ id: string; by: NoteChoice }>, postId: string, member: string | undefined): { index: number; by: NoteChoice } {
  if (member !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(member) || Number(member) >= map.members.length) {
      throw new Error(`--member must be a zero-based ordinal of the Thread's Map (0 to ${map.members.length - 1}); got ${JSON.stringify(member)}.`);
    }
    return { index: Number(member), by: "asked" };
  }
  const found = memberMatches(map, candidates);
  if (found) return found;
  const first = firstThreadPostMember(map);
  if (first !== undefined) return { index: first, by: "first-member" };
  const listed = map.members.flatMap((entry, index) => typeof (entry as MapPositionMember).position === "string" ? [`  ${memberLine(map, index)}`] : []).join("\n");
  throw new Error(
    `Neither post ${postId}, the post that carries the Map, nor anything they are attached to is a member of the Map, and the Map names no post in a Thread, so no member is the Note. ` +
    `Name one with --member <ordinal>:\n${listed || "  (the Map has no position members)"}`,
  );
}

/**
 * The text a session launched from a point in a Thread starts with, in `agent run`'s order: the
 * Thread's newest Map read at its depths, the Agreement of the one who launches (when given), then
 * the frame: the Thread launched from as it is now (its Agreement whole, a line per post since the
 * Map) and the Note, pinned in its own Thread, whole. Any other Agreement is one line and where to
 * read it. Never refused for size: Map members drop from the last up, then the frame gives way, and
 * `cut` names everything that did, with where to read it. Throws a sentence that says what to do.
 */
export async function assembleLaunchText(input: LaunchTextInput): Promise<LaunchText> {
  const cwd = input.cwd ?? process.cwd();
  if (!POST_ID.test(input.post)) throw new Error(`--post needs a post id (msg_…); got ${JSON.stringify(input.post)}.`);
  const directory = resolveLocalThread(input.thread, cwd);
  const holder = loadThread(directory);
  const started = holder.allPosts.find((entry) => entry.id === input.post);
  if (!started) throw new Error(`Thread ${holder.slug} has no post ${input.post}. Run \`ideaspaces threads open ${holder.slug}\` to see its posts.`);
  const startedFile = join(directory, started.path);

  const source = findLaunchMap(holder, directory);
  const note = loadMapNote(source.file, cwd);
  const chosen = selectNote(note.map, noteCandidates(holder, started, source.post), started.id, input.member);
  const ordinal = chosen.index;
  const selected = note.map.members[ordinal] as MapPositionMember;
  if (typeof selected.position !== "string") throw new Error(`Map member ${ordinal} is an address, not a post in a local Thread; choose a position member with --member.`);
  const home = /^_threads\/([^/]+)\//.exec(selected.position)?.[1];
  if (!home) throw new Error(`Map member ${ordinal} (${selected.position}) is not a post in a Thread; choose another with --member.`);
  const pin = note.map.roots[selected.root]?.sha;
  if (!pin) throw new Error(`Map member ${ordinal} is in root ${selected.root}, which has no pin; a launch reads its Note at a pin.`);

  let pov: { path: string; text: string } | undefined;
  if (input.pov !== undefined) {
    const valid = validateAgentPov(input.pov, { cwd });
    if (!valid.valid) throw new Error(valid.message);
    pov = { path: valid.path, text: renderPovOrientation(valid, readFileSync(valid.contractPath, "utf8")) };
  }

  // The Note is read the way `agent run` reads it: pinned, in its own Thread. Its frame is laid out here.
  const noteDirectory = join(dirname(directory), home);
  const pinned = prepareThreadLaunch(pov?.path ?? threadBase(dirname(dirname(directory))), noteDirectory, source.file, String(ordinal), { requireAuthor: false, readOnly: true, frameLimit: false });
  const since = postsSince(holder, source.post);
  // Room is made in this order: the Map's members first (last up, in `loadLaunchMap`), then the lines of posts
  // since the Map, the oldest first, one at a time, and only then the Thread's Agreement, down to one line. What
  // decided the Thread is the cheapest current record, so it outlasts the lines and the Map. The Agreement of the
  // one who launches and the Note never give way.
  const listable = renderLaunchFrame({ holder, directory, started, map: source, since, note: pinned.parts, noteDirectory, noteInLaunchThread: noteDirectory === directory, agreement: "whole" }).listed;
  const steps: Array<{ agreement: "whole" | "line"; sinceMax: number }> = [
    ...Array.from({ length: listable + 1 }, (_, i) => ({ agreement: "whole" as const, sinceMax: listable - i })),
    ...Array.from({ length: Math.min(listable, 3) + 1 }, (_, i) => ({ agreement: "line" as const, sinceMax: Math.min(listable, 3) - i })),
  ];
  let frame: LaunchFrame | undefined;
  let map: MapOrientationResult | undefined;
  let failure: unknown;
  for (const step of steps) {
    frame = renderLaunchFrame({ holder, directory, started, map: source, since, note: pinned.parts, noteDirectory, noteInLaunchThread: noteDirectory === directory, ...step });
    try {
      // `agent run` reads the Map with the agent folder as its context, which sets how the Map's own path is shown.
      map = await loadLaunchMap(source.file, pov?.path ?? cwd, { pov: pov?.text, frame: frame.text, loadedAsNote: pinned.citation, budget: input.budget });
      break;
    } catch (error) {
      if (!(error instanceof LaunchSizeError) && !(error instanceof MapBudgetError)) throw error;
      failure = error;
    }
  }
  if (!map || !frame) {
    const sizes = launchSizes({ pov: pov?.text, frame: frame?.text });
    throw new LaunchSizeError(
      `The Agreement of the one who launches (${sizes.pov} bytes) and the Note (${sizes.frame} bytes with the Thread's frame) leave no room in ${MAX_ORIENTATION_BYTES} bytes for even a pointer to the Map. ` +
      `${failure instanceof Error ? failure.message : ""} Launch with a shorter Agreement, or from a Thread whose Note is shorter.`.trim(),
      sizes,
    );
  }

  const text = [map.text, pov?.text, frame.text].filter(Boolean).join("\n\n");
  const sizes = launchSizes({ map: map.text, pov: pov?.text, frame: frame.text });
  const readAt = (entry: { path?: string; address: string }) => entry.path ?? entry.address;

  const cut: LaunchText["cut"] = [
    ...map.lowered.map((entry) => ({
      kind: "depth" as const,
      ...entry,
      reason: `over the Map's ${map.budget}-character budget; read it whole at ${readAt(entry)}`,
    })),
    ...map.dropped.map((entry) => ({
      kind: "dropped" as const,
      ...entry,
      reason: `over the Map's ${map.budget}-character budget even at name; read it at ${readAt(entry)}`,
    })),
    ...(map.legendOmitted ? [{ kind: "legend" as const, reason: `over the Map's ${map.budget}-character budget; the legend is in ${basename(source.file)}` }] : []),
    ...(frame.omittedSince ? [{
      kind: "posts" as const,
      omitted: frame.omittedSince,
      reason: `the lines of posts since the Map are over their budget; the oldest ${frame.omittedSince} are not listed; \`ideaspaces threads open ${holder.slug}\` lists every post`,
    }] : []),
    ...(frame.agreement === "line" ? [{
      kind: "agreement" as const,
      path: join(directory, "_agent", "agreement.md"),
      reason: "the launch had no room for this Thread's Agreement whole; read it in full at its path",
    }] : []),
  ];

  return {
    schema: "ideaspaces.threads.launch-text.v1",
    text,
    chars: text.length,
    bytes: sizes.total,
    max_bytes: MAX_ORIENTATION_BYTES,
    thread: { slug: holder.slug, path: directory },
    post: { id: started.id, path: startedFile },
    map_post: { id: source.post.id, path: source.file, kind: source.post.kind, origin: source.origin },
    since: { total: since.length, listed: since.length - frame.omittedSince },
    note: {
      thread: pinned.receipt.thread,
      post: pinned.parentId,
      member: ordinal,
      by: chosen.by,
      position: selected.position,
      pin,
      closed: pinned.closed,
    },
    agreement: frame.agreement,
    map: { budget: map.budget, chars: map.text.length },
    lowered: map.lowered,
    dropped: map.dropped,
    cut,
    merged: map.merged,
    receipt: pinned.receipt,
  };
}
