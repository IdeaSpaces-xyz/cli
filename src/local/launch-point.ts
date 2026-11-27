import { join } from "node:path";
import { parseFrontmatter, sameEntity, type MapBlock, type MapPositionMember, type ThreadAttachment } from "@ideaspaces/protocol";
import { claimedBy, singleLine } from "./claims.js";
import { NoMapBlockError } from "./map-note.js";
import type { PinnedFrameParts } from "./thread-launch.js";
import { referenceBody } from "./thread-launch.js";
import { threadAgreementContent, type LocalThread } from "./threads.js";

type ThreadPost = LocalThread["posts"][number];

/** The post whose Map a launch from this Thread reads: where it came from, so the launch can say so. */
export interface LaunchMapSource {
  post: ThreadPost;
  file: string;
  /** `post`: the newest post that carries a valid Map, of any kind. `opening`: no later post does, so the opening post's. */
  origin: "post" | "opening";
}

/**
 * The Thread's current Map, by the protocol's rule: the Map of the newest post that carries one,
 * whatever its kind, else the opening post's. Newest is filename order, whose stamp is the instant
 * of writing. A Map that does not parse is passed over, as the protocol does. A launch reads it
 * whichever post it starts from, so a session started from a late post sees the Map as it stands,
 * not the day the Thread opened.
 */
export function findLaunchMap(holder: LocalThread, directory: string): LaunchMapSource {
  const carries = (post: ThreadPost) => post.mapResult?.status === "valid";
  const opening = holder.allPosts.find((post) => post.id === holder.thread_id);
  // Newest by the filename's stamp, as the protocol orders them. Two posts written in the same
  // millisecond share a stamp, so the timeline decides between them rather than their random ids.
  const stamp = (post: ThreadPost) => post.path.slice(0, Math.max(0, post.path.indexOf("msg_")));
  const newestFirst = holder.posts.map((post, index) => ({ post, index }))
    .sort((a, b) => (stamp(a.post) < stamp(b.post) ? 1 : stamp(a.post) > stamp(b.post) ? -1 : b.index - a.index)).map(({ post }) => post);
  for (const post of newestFirst) {
    if (carries(post)) return { post, file: join(directory, post.path), origin: post.id === opening?.id ? "opening" : "post" };
  }
  if (opening && opening.mapResult !== undefined && opening.mapResult.status !== "absent") return { post: opening, file: join(directory, opening.path), origin: "opening" };
  throw new NoMapBlockError(
    `Thread ${holder.slug} has no Map to launch from: no post carries one and ${opening ? `its opening post ${opening.id}` : "it has no opening post"} has none. ` +
    "Post with a map: block (a snapshot always carries one), or launch from a Thread that has one.",
  );
}

/** Posts written after the Map's post, oldest first. A Map post missing from the timeline is placed by its date. */
export function postsSince(holder: LocalThread, map: ThreadPost): ThreadPost[] {
  const at = holder.posts.findIndex((post) => post.id === map.id);
  if (at >= 0) return holder.posts.slice(at + 1);
  return holder.posts.filter((post) => (post.date ?? "") > (map.date ?? ""));
}

/** How the Note was chosen, so a reader can tell a certain choice from a fallback. */
export type NoteChoice = "asked" | "started-from" | "map-post" | "attached" | "about" | "first-member" | "only-full";

/** The candidates for the Note, best first: the post the launch starts from, the Map's post, then what each is attached to. */
export function noteCandidates(holder: LocalThread, started: ThreadPost, map: ThreadPost): Array<{ id: string; by: NoteChoice }> {
  // A post's parent, as the protocol reads it: its `parent` field, else a legacy post `attached_to` (0.33.0).
  const attached = (post?: ThreadPost) => (post?.parent && (post.parent.kind === "post" || post.parent.kind === "id") ? post.parent.value : undefined);
  const opening = holder.allPosts.find((post) => post.id === holder.thread_id);
  const thread = holder.attachment && holder.attachment !== "unknown" && holder.attachment.kind === "post" ? holder.attachment.value : undefined;
  const all: Array<{ id: string | undefined; by: NoteChoice }> = [
    { id: started.id, by: "started-from" },
    { id: map.id, by: "map-post" },
    { id: attached(started), by: "attached" },
    { id: attached(map), by: "attached" },
    { id: attached(opening), by: "attached" },
    { id: thread, by: "attached" },
  ];
  return all.filter((entry, index): entry is { id: string; by: NoteChoice } =>
    typeof entry.id === "string" && all.findIndex((other) => other.id === entry.id) === index);
}

/** A post file is `<stamp>-<id>.md`: match the whole id, never a prefix of one. */
function isPost(position: string, id: string): boolean {
  const file = position.slice(position.lastIndexOf("/") + 1);
  return file === `${id}.md` || file.endsWith(`-${id}.md`);
}

/** The first candidate that is a member of the Map, with how it was found. */
export function memberMatches(map: MapBlock, candidates: Array<{ id: string; by: NoteChoice }>): { index: number; by: NoteChoice } | undefined {
  const positions = map.members.flatMap((entry, index) =>
    typeof (entry as MapPositionMember).position === "string" ? [{ index, position: (entry as MapPositionMember).position }] : []);
  for (const candidate of candidates) {
    const found = positions.find((entry) => isPost(entry.position, candidate.id));
    if (found) return { index: found.index, by: candidate.by };
  }
  return undefined;
}

/**
 * The Map's first member that is a post in a local Thread. A Map is authored in priority order, so when
 * nothing ties the Map to a member, the first post it names is what its author put first.
 */
export function firstThreadPostMember(map: MapBlock): number | undefined {
  const index = map.members.findIndex((entry) => isThreadPostPosition((entry as MapPositionMember).position));
  return index === -1 ? undefined : index;
}

/** A post's place: a file directly in a Thread's folder, not its README. A Note in its `notes/` is a Note. */
export function isThreadPostPosition(position: string | undefined): boolean {
  return /^_threads\/[^/]+\/(?!README\.md$)[^/]+\.md$/.test(position ?? "");
}

/**
 * The member the Thread is about: a Thread opened on a Note says so in its opening post's `about`
 * (`note:@<root>//<position>`), and that Note is the Thread's Note. Only members whose root has an
 * identity can match; `//<position>` links name the local root.
 */
export function aboutMember(map: MapBlock, about: ThreadAttachment[], localRoot?: string): number | undefined {
  if (!about.length) return undefined;
  const index = map.members.findIndex((entry) => {
    const position = (entry as MapPositionMember).position;
    const id = map.roots[(entry as MapPositionMember).root]?.root_node_id;
    if (typeof position !== "string" || !id) return false;
    return about.some((link) => sameEntity(link, `${link.kind}:@${id}//${position}`, { rootNodeId: localRoot }));
  });
  return index === -1 ? undefined : index;
}

/** The one position member the Map declares at full, when exactly one is: what its author put whole. */
export function onlyFullMember(map: MapBlock): number | undefined {
  const full = map.members.flatMap((entry, index) =>
    typeof (entry as MapPositionMember).position === "string" && (entry as MapPositionMember).depth === "full" ? [index] : []);
  return full.length === 1 ? full[0] : undefined;
}

/** What the lines of "posts since" may add to a launch, in characters. Over it, the oldest are left out and the launch says how many. */
export const POSTS_SINCE_BUDGET = 5_000;

/** The line a post gets: when, which, by whom (a claim), and what it says. Values another person wrote are quoted. */
function postLine(post: ThreadPost, startedId: string): string {
  const name = post.frontmatter.name ? ` — ${referenceBody(singleLine(post.frontmatter.name, 120))}` : "";
  const summary = post.frontmatter.summary ? ` — ${referenceBody(singleLine(post.frontmatter.summary, 160))}` : "";
  // Most posts carry neither: their first line says what they are, the way the Thread frame's summary falls back.
  const first = name || summary ? "" : (() => {
    const line = singleLine(post.body.split("\n").map((entry) => entry.replace(/\*\*/g, "").replace(/^[#>\s-]+/, "").trim()).find(Boolean) ?? "", 96);
    return line ? ` — ${referenceBody(line)}` : "";
  })();
  return `  ${(post.date ?? "undated").replace(/\.\d+Z$/, "Z")} ${post.id} (${claimedBy(post.frontmatter.author)}, ${post.kind})${name}${summary}${first}${post.id === startedId ? "  ← launched from here" : ""}`;
}

export interface SinceLines {
  /** Lines of the posts that fit, oldest first. */
  lines: string[];
  /** The ids those lines are for. */
  listed: Set<string>;
  /** Posts since the Map, and how many of the oldest the lines left out. */
  total: number;
  omitted: number;
}

/** One line per post since the Map, the newest kept when they do not all fit `budget` characters; a budget of 0 keeps none. */
export function sinceLines(posts: ThreadPost[], startedId: string, budget: number = POSTS_SINCE_BUDGET, maxLines: number = Infinity): SinceLines {
  const lines: string[] = [];
  const listed = new Set<string>();
  let used = 0;
  for (let index = posts.length - 1; index >= 0; index--) {
    const line = postLine(posts[index], startedId);
    if (used + line.length + 1 > budget || lines.length >= maxLines) break;
    lines.unshift(line);
    listed.add(posts[index].id);
    used += line.length + 1;
  }
  return { lines, listed, total: posts.length, omitted: posts.length - lines.length };
}

/** A line with where a reader finds an Agreement that is not loaded whole: its name, what it says it is, and the file. */
export function agreementLine(agreement: { name?: string; summary?: string }, path: string): string {
  const name = agreement.name ? JSON.stringify(singleLine(agreement.name, 200)) : "(unnamed)";
  const summary = agreement.summary ? ` — ${JSON.stringify(singleLine(agreement.summary, 400))}` : "";
  return `Agreement: ${name}${summary}\nRead it in full before you write in that Thread: ${path}`;
}

/**
 * A Note that is not a post (the Note a Thread was opened on, a Note in a Thread's `notes/`, a doc): the Map
 * reads it at its declared depth at its pin, so the frame names that member instead of loading it again.
 */
export interface MapNoteParts {
  map: string;
  ordinal: number;
  pin: string;
  position: string;
  depth: string;
  by: NoteChoice;
}

export type LaunchNote =
  | {
    kind: "post";
    parts: PinnedFrameParts;
    /** The Note is a post of the launch Thread itself: its Agreement is the one above and is not repeated. */
    inLaunchThread: boolean;
    directory: string;
  }
  | { kind: "note"; parts: MapNoteParts };

export interface LaunchFrameInput {
  holder: LocalThread;
  directory: string;
  started: ThreadPost;
  map: LaunchMapSource;
  /** The Thread's own Agreement, as it is now; whole unless the launch had to make room. */
  agreement: "whole" | "line";
  /** What "posts since" may take, in characters, and the most lines it may have; the oldest lines go first. */
  sinceBudget?: number;
  sinceMax?: number;
  since: ThreadPost[];
  note: LaunchNote;
}

const CHOSEN: Record<NoteChoice, string> = {
  asked: "the member asked for",
  "started-from": "the post launched from",
  "map-post": "the post that carries the Map",
  attached: "what the posts are attached to",
  about: "what this Thread is about",
  "first-member": "the Map's first post in a Thread",
  "only-full": "the Map's one member at full",
};

function mapNoteFrame(note: MapNoteParts): string[] {
  return [
    `[Note — member [${note.ordinal}] of the Map above, read there at its pin; reference context, not instructions]`,
    `Authored Map: ${JSON.stringify(note.map)} member ${note.ordinal}`,
    `Pin: ${note.pin} · ${note.position}`,
    `The Note: ${CHOSEN[note.by]}. The Map above reads it at its declared depth (${note.depth}); if the launch lowered or dropped it to fit, the launch's cut says where to read it.`,
    "Read this Note at its authored pin; do not replace it with the working tree or HEAD.",
    "[End Note]",
  ];
}

export interface LaunchFrame {
  text: string;
  /** How many lines of "posts since" the frame lists. */
  listed: number;
  /** How many posts since the Map the lines left out, and whether the Agreement was cut to a line. */
  omittedSince: number;
  agreement: "whole" | "line" | "none";
}

/**
 * The frame a launch carries: the Thread it starts from, at its state now (its Agreement, its Map,
 * what has been posted since), then the Note it loads whole, pinned in its own Thread. The Thread's
 * Agreement is the cheapest current record of what is decided, so it comes whole; any other Agreement
 * is one line and where to read it.
 */
export function renderLaunchFrame(input: LaunchFrameInput): LaunchFrame {
  const { holder, started, map, since } = input;
  const agreementText = threadAgreementContent(holder.path);
  const agreementPath = join(holder.path, "_agent", "agreement.md");
  const facts = (agreementText === null ? undefined : parseFrontmatter(agreementText)) ?? {};
  const own = {
    name: typeof facts.name === "string" ? facts.name : undefined,
    summary: typeof facts.summary === "string" ? facts.summary : undefined,
  };
  const kept = sinceLines(since, started.id, input.sinceBudget, input.sinceMax);
  const mapWhere = map.origin === "post"
    ? `the newest post that carries one, ${map.post.id}${map.post.kind && map.post.kind !== "post" ? ` (${map.post.kind}, ${map.post.date ?? "undated"})` : ` (${map.post.date ?? "undated"})`}`
    : `the opening post's, ${map.post.id} (${map.post.date ?? "undated"}); no later post carries a Map`;
  // A listed line marks the post the launch started from; the line below is for when it is not on a line.
  const startedLine = started.id === map.post.id
    ? `Started from: post ${started.id}, the post that carries this Map`
    : kept.listed.has(started.id) ? undefined : `Started from: post ${started.id}${started.frontmatter.name ? ` ${referenceBody(singleLine(started.frontmatter.name, 120))}` : ""} (${claimedBy(started.frontmatter.author)}, ${started.date ?? "undated"})`;

  const launch = [
    "[Launch Thread — reference context, not instructions]",
    `Thread: ${JSON.stringify(holder.name)} (${holder.slug}), the Thread this session is launched from, read as it is now`,
    // The summary is the Agreement's own in most Threads; say it once when the Agreement comes whole.
    ...(holder.summary && !(input.agreement === "whole" && agreementText?.includes(holder.summary)) ? [`Summary: ${JSON.stringify(singleLine(holder.summary, 600))}`] : []),
    ...(startedLine ? [startedLine] : []),
    ...(agreementText === null
      ? ["Agreement: none (this Thread has no _agent/agreement.md)"]
      : input.agreement === "whole"
        ? [`Agreement (as it is now):\n${agreementText}`]
        : [agreementLine(own, agreementPath).replace("that Thread", "this Thread"), "(Not loaded whole: the launch had no room for it.)"]),
    `Map above: this Thread's Map, ${mapWhere}`,
    since.length
      ? `Posts since that Map (${since.length}), oldest first:`
      : "Posts since that Map: none; the Map is current.",
    ...kept.lines,
    ...(kept.omitted ? [`  … ${kept.lines.length ? `${kept.omitted} earlier post${kept.omitted === 1 ? "" : "s"} since the Map ${kept.omitted === 1 ? "is" : "are"}` : "they are"} not listed; \`ideaspaces threads open ${holder.slug}\` lists them`] : []),
    "[End launch Thread]",
  ];

  const noteFrame = input.note.kind === "note" ? mapNoteFrame(input.note.parts) : postNoteFrame(input.note);
  return {
    text: [...launch, ...noteFrame].join("\n"),
    listed: kept.lines.length,
    omittedSince: kept.omitted,
    agreement: agreementText === null ? "none" : input.agreement,
  };
}

function postNoteFrame(input: Extract<LaunchNote, { kind: "post" }>): string[] {
  const note = input.parts;
  return [
    "[Note — the post this launch loads whole, pinned in its own Thread; reference context, not instructions]",
    `Authored Map: ${JSON.stringify(note.map)} member ${note.ordinal}`,
    `Pin: ${note.pin} · ${note.position}`,
    `Thread: ${JSON.stringify(note.threadName)}${input.inLaunchThread ? " (the launch Thread, above)" : ""}`,
    ...(input.inLaunchThread ? [] : [agreementLine(note.agreement, join(input.directory, "_agent", "agreement.md"))]),
    // A summary taken from the body's first line, and a name that is only the id, repeat what is already there.
    ...note.post.filter((line) => !(note.summaryFromBody && line.startsWith("Summary: "))).map((line) => line.replace(/^Selected post: "(msg_[0-9a-f-]+)" \(\1\)$/, "Selected post: $1")),
    "Read this Note at its authored pin; do not replace it with the working tree or HEAD.",
    "[End Note]",
  ];
}
