import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MapBlock, MapPositionMember } from "@ideaspaces/protocol";
import { validateAgentPov } from "./agent-pov.js";
import { loadMapNote } from "./map-note.js";
import {
  loadMapOrientation,
  MAP_ORIENTATION_BUDGET,
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
 * the Agreement and the Thread frame leave, up to its own budget, and lowers its last member first
 * (the usual order) when that is less. A frame and Agreement that do not fit alone are refused as
 * before, since no Map can help; a Map that cannot fit even at name is refused, saying so.
 */
export async function loadLaunchMap(
  reference: string,
  context: string,
  parts: { pov?: string; frame: string; loadedAsNote?: MapBlock; budget?: number },
): Promise<MapOrientationResult> {
  const alone = launchSizeError(launchSizes({ pov: parts.pov, frame: parts.frame }));
  if (alone) throw new Error(alone);
  const room = MAX_ORIENTATION_BYTES - Buffer.byteLength([parts.pov, parts.frame].filter(Boolean).join("\n\n")) - 2;
  let limit = Math.min(parts.budget ?? MAP_ORIENTATION_BUDGET, room);
  for (let attempt = 0; attempt < 6 && limit > 0; attempt++) {
    let loaded: MapOrientationResult;
    try {
      loaded = await loadMapOrientation(reference, context, { budget: limit, loadedAsNote: parts.loadedAsNote });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Only a size failure is about the room; a Map that cannot be read says what it says.
      if (!/every member at name/.test(detail)) throw error;
      throw new Error(`${detail} The Agreement and the Thread frame leave ${room} of ${MAX_ORIENTATION_BYTES} bytes for the Map.`);
    }
    const over = Buffer.byteLength(loaded.text) - room;
    if (over <= 0) return loaded;
    // Multi-byte characters make bytes exceed the character budget; take the difference off and read again.
    limit = Math.min(limit, loaded.text.length) - over;
  }
  throw new Error(`The Map does not fit in the ${room} of ${MAX_ORIENTATION_BYTES} bytes the Agreement and the Thread frame leave. Use a smaller Map.`);
}

export interface CutMember extends MapOrientationLowered {
  kind: "depth";
  reason: string;
}

export interface CutLegend {
  kind: "legend";
  reason: string;
}

export interface LaunchText {
  schema: "ideaspaces.threads.launch-text.v1";
  /** The assembled launch text: the Map, then the Agreement when one was given, then the Thread frame. */
  text: string;
  chars: number;
  bytes: number;
  max_bytes: number;
  thread: { slug: string; path: string };
  post: { id: string; path: string };
  /** The post this launch loads whole, with the Thread's Agreement: a member of the post's Map. */
  note: { thread: string; post: string; member: number; position: string; pin: string; closed: boolean | "unknown" };
  map: { budget: number; chars: number };
  /** Members read at a lower depth than declared, as the Map budget required. */
  lowered: MapOrientationLowered[];
  /** Everything that did not arrive whole, so a reader can reach it: each lowered member with its address, and a dropped legend. */
  cut: Array<CutMember | CutLegend>;
  /** Members the Map left out because the same post is the Note. */
  merged: MapOrientationMerged[];
  receipt: ThreadReadReceipt;
}

export interface LaunchTextInput {
  /** The Thread that holds the post: a slug or a path. */
  thread: string;
  /** The post whose own Map is the launch Map. */
  post: string;
  /** Which member of that Map is the Note. Without it: the post itself, else the post it is attached to. */
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

/** The Note's ordinal: the one asked for, else the post in its own Map, else the post it is attached to. */
function selectNote(map: MapBlock, postId: string, attachedTo: string | undefined, member: string | undefined): number {
  if (member !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(member) || Number(member) >= map.members.length) {
      throw new Error(`--member must be a zero-based ordinal of the post's Map (0 to ${map.members.length - 1}); got ${JSON.stringify(member)}.`);
    }
    return Number(member);
  }
  const positions = map.members.flatMap((entry, index) =>
    typeof (entry as MapPositionMember).position === "string" ? [{ index, position: (entry as MapPositionMember).position }] : []);
  // A post file is `<stamp>-<id>.md`: match the whole id, never a prefix of one.
  const isPost = (position: string, id: string) => {
    const file = position.slice(position.lastIndexOf("/") + 1);
    return file === `${id}.md` || file.endsWith(`-${id}.md`);
  };
  for (const id of [postId, attachedTo]) {
    const found = id ? positions.find((entry) => isPost(entry.position, id)) : undefined;
    if (found) return found.index;
  }
  const listed = positions.map((entry) => `  ${memberLine(map, entry.index)}`).join("\n");
  throw new Error(
    `Post ${postId} is not a member of its own Map${attachedTo ? ` and neither is ${attachedTo}` : " and is attached to no post"}, so no member is its Note. ` +
    `Name one with --member <ordinal>:\n${listed || "  (the Map has no position members)"}`,
  );
}

/**
 * The text a session launched from a point in a Thread starts with: the post's own Map read at its
 * depths, the Agreement of the one who launches (when given), and the Note pinned in its Thread —
 * built by the same functions, in the same order, as `agent run --map --thread --thread-map`.
 * Reads only at authored pins. Throws a sentence that says what to do.
 */
export async function assembleLaunchText(input: LaunchTextInput): Promise<LaunchText> {
  const cwd = input.cwd ?? process.cwd();
  if (!POST_ID.test(input.post)) throw new Error(`--post needs a post id (msg_…); got ${JSON.stringify(input.post)}.`);
  const directory = resolveLocalThread(input.thread, cwd);
  const holder = loadThread(directory);
  const post = holder.allPosts.find((entry) => entry.id === input.post);
  if (!post) throw new Error(`Thread ${holder.slug} has no post ${input.post}. Run \`ideaspaces threads open ${holder.slug}\` to see its posts.`);
  const file = join(directory, post.path);

  let note;
  try {
    note = loadMapNote(file, cwd);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/has no map block/.test(detail)) throw new Error(`Post ${post.id} carries no Map; a launch from a point needs a post with a map: block.`);
    throw error;
  }
  const attached = post.attachedTo?.kind === "post" ? post.attachedTo.value : undefined;
  const ordinal = selectNote(note.map, post.id, attached, input.member);
  const selected = note.map.members[ordinal] as MapPositionMember;
  if (typeof selected.position !== "string") throw new Error(`Map member ${ordinal} is an address, not a post in a local Thread; choose a position member with --member.`);
  const home = /^_threads\/([^/]+)\//.exec(selected.position)?.[1];
  if (!home) throw new Error(`Map member ${ordinal} (${selected.position}) is not a post in a Thread; choose another with --member.`);

  let pov: { path: string; text: string } | undefined;
  if (input.pov !== undefined) {
    const valid = validateAgentPov(input.pov, { cwd });
    if (!valid.valid) throw new Error(valid.message);
    pov = { path: valid.path, text: renderPovOrientation(valid, readFileSync(valid.contractPath, "utf8")) };
  }

  // The same call `agent run` makes. The Note's Thread is the member's, resolved beside the post's.
  const noteDirectory = join(dirname(directory), home);
  const frame = prepareThreadLaunch(pov?.path ?? threadBase(dirname(dirname(directory))), noteDirectory, file, String(ordinal), { requireAuthor: false, readOnly: true });
  // `agent run` reads the Map with the agent folder as its context, which sets how the Map's own path is shown.
  const map = await loadLaunchMap(file, pov?.path ?? cwd, { pov: pov?.text, frame: frame.orientation, loadedAsNote: frame.citation, budget: input.budget });

  const text = [map.text, pov?.text, frame.orientation].filter(Boolean).join("\n\n");
  const sizes = launchSizes({ map: map.text, pov: pov?.text, frame: frame.orientation });

  const cut: LaunchText["cut"] = [
    ...map.lowered.map((entry) => ({
      kind: "depth" as const,
      ...entry,
      reason: `over the Map's ${map.budget}-character budget; read it whole with is_look or is_navigate`,
    })),
    ...(map.legendOmitted ? [{ kind: "legend" as const, reason: `over the Map's ${map.budget}-character budget; the legend is in ${basename(file)}` }] : []),
  ];

  return {
    schema: "ideaspaces.threads.launch-text.v1",
    text,
    chars: text.length,
    bytes: sizes.total,
    max_bytes: MAX_ORIENTATION_BYTES,
    thread: { slug: holder.slug, path: directory },
    post: { id: post.id, path: file },
    note: {
      thread: frame.receipt.thread,
      post: frame.parentId,
      member: ordinal,
      position: selected.position,
      pin: note.map.roots[selected.root]?.sha ?? "",
      closed: frame.closed,
    },
    map: { budget: map.budget, chars: map.text.length },
    lowered: map.lowered,
    cut,
    merged: map.merged,
    receipt: frame.receipt,
  };
}
