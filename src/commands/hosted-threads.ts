/**
 * Hosted Threads (`x_<id>`) and Vaults over /api/v1/threads and /api/v1/vaults.
 *
 * Ported from Idea Explorer's own hosted Thread client rather than rewritten, so a host
 * that swaps its transport for this CLI reads the same shapes:
 *   - the failure states and the HTTP status that names each;
 *   - response validation (a malformed answer is invalid_response, never a partial page);
 *   - opaque cursors bound to the service and Thread, by kind: `older` pages back with
 *     before_seq; `follow` reads forward with after_seq and, once a page is drained,
 *     advances to the pre-read head, because corrections and marks consume seq but are
 *     folded out of the page; `list` wraps the service's own cursor;
 *   - a post is one Note built once; a POST is never retried, and an exact resend with
 *     the same --post-id is what the service accepts after an ambiguous failure.
 *
 * Who wrote a post and when come from the service's record (principal, actor, surface,
 * received_at), never from the Note's own `author:` or `date:` frontmatter.
 * One deliberate difference from that client: a cursor is bound to the service origin, not to
 * a person id, because a host-run CLI is handed a token and no person identifier.
 * A cursor is never authority; the service checks access on every read.
 */

import { randomUUID } from "node:crypto";
import { HOSTED_THREAD_ID, parseMap, parseThreadPost } from "@ideaspaces/protocol";
import { stringify } from "yaml";
import { loadLocalThreadMap } from "../local/thread-map-member.js";
import { validateTags } from "../local/threads.js";
import {
  ackHostedThread, ApiStatusError, appendHostedThreadPost, fetchHostedThread, fetchHostedThreadPosts, fetchVaults,
  listHostedThreads, NetworkError, openHostedThread, UnauthorizedError, type ApiConfig,
} from "../auth/api.js";
import { HostAuthRefusal, hostedConfig, isHostAuth, type HostedConfig } from "../auth/credentials.js";
import type { Output } from "../output.js";
import { outOfDateMessage } from "../update-check.js";
import { NODE_ID } from "./thread-flags.js";

const POST_ID = /^msg_[a-zA-Z0-9_-]{1,60}$/;
const MAX_NOTE_BYTES = 32 * 1024; // the service refuses a larger Note (413)

export type HostedFailure = "signed_out" | "expired" | "forbidden" | "not_found" | "offline" | "rate_limited" | "conflict" | "invalid_request" | "invalid_response" | "unavailable";

function messages(state: HostedFailure, subject: "thread" | "vaults"): string {
  const host = isHostAuth();
  const signIn = host ? "Sign in under Account settings in Idea Explorer" : "Run `ideaspaces login`";
  const thread = subject === "thread";
  switch (state) {
    case "signed_out": return `Not signed in to IdeaSpaces. ${signIn} to ${thread ? "read or reply to hosted Threads" : "list your Vaults"}.`;
    case "expired": return host
      ? "The app's IdeaSpaces sign-in was refused (401). Sign in again under Account settings in Idea Explorer; keep your reply draft."
      : "Your IdeaSpaces sign-in expired or was revoked (401). Run `ideaspaces login` again; keep your reply draft.";
    case "forbidden": return thread ? "You do not have access to this Thread or action." : "My Vaults is for a person's own sign-in; this credential was refused (403).";
    case "not_found": return "This hosted Thread could not be found, or this sign-in has no access to it (the service answers 404 for both).";
    case "offline": return "IdeaSpaces could not be reached. Check your connection and retry; keep the same reply id.";
    case "rate_limited": return "IdeaSpaces is busy. Wait before retrying; keep the same reply id.";
    case "conflict": return "This post id conflicts with stored text, or the Thread is closed. An exact resend (including close confirmation) needs the same --post-id and --message. Read the Thread to check its state; closed Threads cannot be reopened.";
    case "invalid_request": return thread
      ? "The Thread request is invalid. Use a cursor from this command for this Thread, and a reply with an explicit parent."
      : "The Vaults request is invalid.";
    case "invalid_response": return `IdeaSpaces returned an unreadable ${thread ? "Thread" : "Vaults"} response. Retry, or update the ideaspaces CLI.`;
    case "unavailable": return "IdeaSpaces is unavailable. Try again later; keep the same reply id.";
  }
}

export class HostedError extends Error {
  /** `settled`: the service refused and stored nothing, so there is no post to resend. */
  constructor(readonly state: HostedFailure, message?: string, readonly retryAfterMs?: number, readonly settled = false) {
    super(message ?? state);
    this.name = "HostedError";
  }
}

function tryAgain(ms: number | undefined): string {
  if (ms === undefined) return "Try again later.";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "Try again in a minute.";
  if (minutes < 120) return `Try again in ${minutes} minutes.`;
  return `Try again in about ${Math.round(minutes / 60)} hours.`;
}

const FIRST_CONTACT = "This person is new to you, so your first message is a knock";

/**
 * The service's refusals of a first contact and of a held knock, in words that say what happened
 * and what to do. Each stored nothing. Matched on the service's own detail; one this CLI doesn't
 * know still reaches the reader, as "Service: ...".
 */
const REFUSALS: ReadonlyArray<[RegExp, (match: RegExpExecArray, retryAfterMs?: number) => string]> = [
  [/^Knock first/, () => "One of these people is new to you, and someone new can't join a Thread with others. Nothing was sent. Reach them on their own with `ideaspaces threads send @handle`, which sends a knock."],
  [/^This person answered your knock/, () => "This person answered your knock, so you can't knock on them again. Nothing was sent."],
  [/^A knock takes no posts until it is answered/, () => "Neither side can post in a knock until it's let in. The person knocked on answers on the web. Nothing was posted."],
  [/^This knock lapsed/, () => "This knock lapsed without an answer, so it takes no more posts. Whoever knocked can knock again. Nothing was posted."],
  [/^A knock's name is set by the server/, () => "The service names a knock, so it can't be renamed. Nothing was posted."],
  [/^Opening msg_ id already used with different input/, () => "This --post-id was already used with different text or a different person. Nothing was sent. To send something new, leave out --post-id. To resend, repeat the first command exactly."],
  [/^A first contact carries no agents/, () => `${FIRST_CONTACT}, and a knock can't bring agents. Nothing was sent. Resend without them.`],
  [/^A first contact is text only/, () => `${FIRST_CONTACT}, and a knock is text only. Nothing was sent. Resend without --map.`],
  [/^A knock needs a message of 1 to (\d+) characters/, (m) => `${FIRST_CONTACT}, which holds 1 to ${Number(m[1]).toLocaleString("en-US")} characters. Nothing was sent. Shorten --message and resend.`],
  [/^Recipient handle not found/, () => "Nobody has that @handle. Check the spelling and resend. Nothing was sent."],
  [/^Cannot address yourself/, () => "You can't name yourself as a recipient. Nothing was sent. Leave yourself out, or leave out --recipients for a Thread of your own."],
  [/^Knock budget exhausted/, (_, wait) => `You've reached the limit on reaching new people for now. Nothing was sent. ${tryAgain(wait)}`],
  [/^Invitation budget exhausted/, (_, wait) => `You've reached the limit on inviting new people for now. Nothing was sent. ${tryAgain(wait)} If this Thread names many email addresses, name fewer: a list over the limit never fits.`],
  [/^This person takes no more knocks for now/, (_, wait) => `This person isn't taking more knocks for now. Nothing was sent. ${tryAgain(wait)}`],
];

const SERVICE_DETAIL: ReadonlySet<HostedFailure> = new Set(["invalid_request", "conflict", "rate_limited", "forbidden"]);

function serviceDetail(body: string): string {
  try {
    const detail = JSON.parse(body).detail;
    return typeof detail === "string" ? detail.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 500) : "";
  } catch { return ""; /* no readable detail */ }
}

const STATUS: Record<number, HostedFailure> = { 401: "expired", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited", 400: "invalid_request", 422: "invalid_request" };

/** Name the state of any failure; a HostAuthRefusal is not a state, it stays a refusal. */
function failureOf(error: unknown, subject: "thread" | "vaults"): HostedError {
  if (error instanceof HostedError) return error.message === error.state ? new HostedError(error.state, messages(error.state, subject), error.retryAfterMs) : error;
  if (error instanceof ApiStatusError) {
    // A retired route. The state stays what hosts parse; the words say what fixes it.
    if (error.status === 410) return new HostedError("unavailable", outOfDateMessage(), error.retryAfterMs);
    const state = STATUS[error.status] ?? "unavailable";
    if (!SERVICE_DETAIL.has(state)) return new HostedError(state, messages(state, subject), error.retryAfterMs);
    const detail = serviceDetail(error.body);
    for (const [pattern, words] of REFUSALS) {
      const match = pattern.exec(detail);
      if (match) return new HostedError(state, words(match, error.retryAfterMs), error.retryAfterMs, true);
    }
    return new HostedError(state, messages(state, subject) + (detail ? ` Service: ${detail}` : ""), error.retryAfterMs);
  }
  // A terminal session's renewal answers with its own instruction ("Retry this command").
  if (error instanceof UnauthorizedError) return new HostedError("expired", error.message);
  if (error instanceof NetworkError) return new HostedError("offline", messages("offline", subject));
  if (error instanceof Error && /^Not logged in/.test(error.message)) return new HostedError("signed_out", messages("signed_out", subject));
  return new HostedError("invalid_response", messages("invalid_response", subject));
}

/** Default combined list shares the same named failure contract as explicit hosted verbs. */
export function hostedFailure(error: unknown): HostedError { return failureOf(error, "thread"); }

function requireValue(ok: unknown, state: HostedFailure = "invalid_response"): asserts ok {
  if (!ok) throw new HostedError(state);
}
const record = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const seq = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

function pageLimit(raw: string | boolean | undefined, dflt = 50): number {
  if (raw === undefined) return dflt;
  const limit = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= 200)) throw new HostedError("invalid_request", "--limit must be a whole number from 1 to 200.");
  return limit;
}

// ─── Cursors ─────────────────────────────────────────────────────

type CursorKind = "list" | "older" | "follow";
interface Cursor { source: string; kind: CursorKind; thread?: string; value: string | number }

function namespace(config: HostedConfig): string {
  return new URL(config.apiUrl).origin;
}
function encode(config: HostedConfig, kind: CursorKind, value: string | number, thread?: string): string {
  return Buffer.from(JSON.stringify({ source: namespace(config), kind, value, thread })).toString("base64url");
}
function decode(config: HostedConfig, cursor: string, kinds: CursorKind[], thread?: string): { kind: CursorKind; value: string | number } {
  const refused = new HostedError("invalid_request", "That cursor is not from this command for this Thread and service. Use the cursor the last page printed.");
  try {
    if (cursor.length > 8192) throw refused;
    const parsed: Cursor = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!(record(parsed) && parsed.source === namespace(config) && kinds.includes(parsed.kind) && parsed.thread === thread
      && (parsed.kind === "list" ? typeof parsed.value === "string" : seq(parsed.value)))) throw refused;
    return { kind: parsed.kind, value: parsed.value };
  } catch { throw refused; }
}

// ─── Projection ──────────────────────────────────────────────────

export interface HostedPost {
  id: string;
  seq: number;
  /** The service's record of who posted: the person, then the acting identity. */
  author: string;
  author_ref: string;
  actor: string;
  actor_label: string;
  surface: string;
  /** The service's received_at, never the Note's own date. */
  date: string;
  edited_at: string | null;
  /** The exact stored Note; its own author/date frontmatter is authored text, not attested. */
  note: string;
  fields: Record<string, unknown>;
  marks: unknown[];
}

function postOf(raw: unknown, thread: string): HostedPost {
  requireValue(record(raw) && raw.thread_id === thread && seq(raw.seq) && raw.seq > 0 && typeof raw.post_id === "string" && POST_ID.test(raw.post_id)
    && typeof raw.note === "string" && record(raw.fields) && typeof raw.actor === "string"
    && typeof raw.actor_label === "string" && typeof raw.surface === "string" && typeof raw.received_at === "string"
    && (raw.marks === undefined || Array.isArray(raw.marks))
    && (raw.principal_ref === undefined || raw.principal_ref === null || typeof raw.principal_ref === "string")
    && (raw.principal_label === undefined || raw.principal_label === null || typeof raw.principal_label === "string"));
  return {
    id: raw.post_id, seq: raw.seq,
    author: raw.principal_label || raw.actor_label, author_ref: raw.principal_ref || raw.actor,
    actor: raw.actor, actor_label: raw.actor_label, surface: raw.surface,
    date: raw.received_at, edited_at: typeof raw.edited_at === "string" ? raw.edited_at : null,
    note: raw.note, fields: raw.fields, marks: raw.marks ?? [],
  };
}

// A grade is the service's word, shown as it comes: a new one must never break a read, here or on
// an install we can't update. Only these may reply; the service holds the real permission.
const REPLY_GRADES = ["Owner", "Editor", "Commenter"];

interface Head { id: string; name: string; closed: boolean; grade: string; can_reply: boolean; knock?: { state: string; can_answer: boolean } }

async function head(config: ApiConfig, id: string): Promise<{ thread: Head; lastSeq: number }> {
  const h: any = await fetchHostedThread(config, id);
  requireValue(record(h) && h.thread_id === id && typeof h.name === "string" && typeof h.closed === "boolean" && seq(h.last_seq)
    && typeof h.grade === "string" && h.grade.length > 0);
  // An older service sends neither field; there the grade still answers.
  const can_reply = typeof h.can_reply === "boolean" ? h.can_reply : !h.closed && REPLY_GRADES.includes(h.grade);
  const knock = record(h.knock) && typeof h.knock.state === "string" ? { knock: { state: h.knock.state, can_answer: h.knock.can_answer === true } } : {};
  return { thread: { id, name: h.name, closed: h.closed, grade: h.grade, can_reply, ...knock }, lastSeq: h.last_seq };
}

/** A knock's state in the status line. A state this CLI doesn't know says nothing. */
function knockStatus(knock: Head["knock"]): string {
  if (knock?.can_answer) return " · knock waiting for you · answer on the web";
  if (knock?.state === "open") return " · knock waiting for an answer";
  if (knock?.state === "lapsed") return " · knock lapsed";
  if (knock?.state === "declined") return " · knock declined";
  return "";
}

async function posts(config: ApiConfig, id: string, query: { limit: number; after_seq?: number; before_seq?: number }): Promise<HostedPost[]> {
  const raw: any = await fetchHostedThreadPosts(config, id, query);
  requireValue(record(raw) && Array.isArray(raw.posts) && raw.posts.length <= query.limit);
  const page = raw.posts.map((p: unknown) => postOf(p, id));
  requireValue(page.every((p: HostedPost, i: number) => (!i || p.seq > page[i - 1].seq)
    && (query.after_seq === undefined || p.seq > query.after_seq) && (query.before_seq === undefined || p.seq < query.before_seq)));
  return page;
}

function bodyOf(note: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(note);
  return (match ? note.slice(match[0].length) : note).trim();
}

function postText(post: HostedPost): string {
  const name = typeof post.fields.name === "string" ? `  ${post.fields.name}` : "";
  const via = post.author_ref !== post.actor ? ` (via ${post.actor_label})` : "";
  return `[${post.seq}] ${post.id}${name}\n  ${post.author}${via} · ${post.date} · ${post.surface}\n\n${bodyOf(post.note)}`;
}

// ─── Notes ───────────────────────────────────────────────────────

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  if (value === true) throw new HostedError("invalid_request", `--${key} requires a value.`);
  return typeof value === "string" ? value : undefined;
}

function postId(flags: Record<string, string | boolean>): string {
  const given = str(flags, "post-id");
  if (given === undefined) return `msg_${randomUUID()}`;
  if (!POST_ID.test(given)) throw new HostedError("invalid_request", "--post-id must be a msg_ id (letters, digits, _ and -, at most 64 characters).");
  return given;
}

function singleLine(flags: Record<string, string | boolean>, key: string, required: boolean): string | undefined {
  const value = str(flags, key);
  if (value === undefined || !value.trim()) {
    if (required) throw new HostedError("invalid_request", `--${key} is required.`);
    return undefined;
  }
  if (/[\r\n]/.test(value) || value.length > 1000) throw new HostedError("invalid_request", `--${key} must be one line of at most 1,000 characters.`);
  return value.trim();
}

/**
 * One Note, built once from the arguments alone (no date: the service attests
 * received_at), so the same --post-id and arguments resend the same bytes.
 */
export function buildNote(fields: Record<string, unknown>, body: string): string {
  const note = `---\n${stringify(fields)}---\n\n${body.trim()}\n`;
  if (Buffer.byteLength(note) > MAX_NOTE_BYTES) throw new HostedError("invalid_request", `The Note is larger than the service accepts (${MAX_NOTE_BYTES / 1024} KiB). Shorten --message.`);
  return note;
}

/** A post's labels, in the Note's own frontmatter: the service stores a Note as written. */
function hostedTags(flags: Record<string, string | boolean>): { tags: string[] } | Record<string, never> {
  if (flags.tags === undefined) return {};
  if (typeof flags.tags !== "string") throw new HostedError("invalid_request", "--tags requires a value.");
  const tags = [...new Set(flags.tags.split(",").map((tag) => tag.trim()))];
  try { validateTags(tags); }
  catch (error) { throw new HostedError("invalid_request", (error as Error).message); }
  return { tags };
}

/** The protocol validates optional disclosure fields; this service additionally requires
 * an authored object on every member. An explicitly empty object is valid; never fill it. */
function hostedMap(flags: Record<string, string | boolean>): { map: unknown } | Record<string, never> {
  if (flags.map === undefined) return {};
  const input = str(flags, "map");
  if (!input?.trim()) throw new HostedError("invalid_request", "--map requires a Map file or inline Map value; no post sent.");
  let value: unknown;
  try { value = loadLocalThreadMap(input); }
  catch (error) { throw new HostedError("invalid_request", error instanceof Error ? error.message : String(error)); }
  const parsed = parseMap(value);
  if (parsed.status !== "valid") throw new HostedError("invalid_request", "--map is not a valid portable Map.");
  const map = parsed.map;
  for (const [i, member] of map.members.entries()) {
    if (!record(member.disclosure)) throw new HostedError("invalid_request", `--map member ${i} needs an authored disclosure object for hosted storage (name/summary of what was observed); no post sent.`);
  }
  return { map };
}

function messageBody(flags: Record<string, string | boolean>): string {
  const body = str(flags, "message");
  if (body === undefined || !body.trim()) throw new HostedError("invalid_request", "--message is required.");
  return body;
}

// ─── Verbs ───────────────────────────────────────────────────────

type Run = (config: HostedConfig) => Promise<{ data: Record<string, unknown>; text: string }>;

/** Ambiguous outcomes of a write: the post may or may not have landed. */
const AMBIGUOUS: ReadonlySet<HostedFailure> = new Set(["offline", "unavailable", "rate_limited", "invalid_response"]);

/** A typed-wrong local name asks the service, so a verb on one named Thread says that may be what happened. */
export const NAMED_THREAD_HINT = "An x_ name with no folder in this Space's _threads/ is read as a hosted id; for a local Thread, give its path.";
const HINTED: ReadonlySet<HostedFailure> = new Set(["not_found", "signed_out", "offline", "unavailable"]);

async function runHosted(output: Output, json: boolean, what: string, subject: "thread" | "vaults", work: Run, { retry, namesThread = false }: { retry?: { postId: string; verb: string }; namesThread?: boolean } = {}): Promise<number> {
  try {
    // Host mode without --token-fd: HostAuthRefusal, rethrown below as every remote command refuses.
    const config = hostedConfig(what);
    const { data, text } = await work(config);
    output.result(data, text);
    return 0;
  } catch (error) {
    if (error instanceof HostAuthRefusal) throw error;
    const failure = failureOf(error, subject);
    const resend = retry && AMBIGUOUS.has(failure.state) && !failure.settled
      ? ` The post may or may not have landed: resend with --post-id ${retry.postId}${retry.verb === "close" ? " --yes" : ""} and the same arguments; the service accepts an exact resend once.`
      : "";
    const hint = namesThread && HINTED.has(failure.state) ? ` ${NAMED_THREAD_HINT}` : "";
    if (json) {
      process.stdout.write(JSON.stringify({ schema: "ideaspaces.hosted.error.v1", error: {
        state: failure.state, message: failure.message + resend + hint,
        ...(failure.retryAfterMs !== undefined ? { retry_after_ms: failure.retryAfterMs } : {}),
        ...(retry ? { post_id: retry.postId } : {}),
      } }, null, 2) + "\n");
    }
    output.error(`Error (${failure.state}): ${failure.message}${resend}${hint}`);
    return 1;
  }
}

export async function vaultsVerb(output: Output, json: boolean): Promise<number> {
  return runHosted(output, json, "Listing your Vaults", "vaults", async (config) => {
    const raw: any = await fetchVaults(config);
    const roots = (x: unknown) => Array.isArray(x) && x.every((r) => record(r) && typeof r.root_node_id === "string" && typeof r.name === "string");
    requireValue(record(raw) && record(raw.personal) && roots(raw.personal.roots) && Array.isArray(raw.orgs)
      && raw.orgs.every((o: unknown) => record(o) && typeof o.hostname === "string" && roots(o.roots)) && roots(raw.shared_with_me));
    const line = (r: any) => `  ${r.root_node_id}  ${r.name}${r.level ? ` · ${r.level}` : ""}${r.archived ? " · archived" : ""}`;
    const text = [
      `Personal${raw.personal.handle ? ` (@${raw.personal.handle})` : ""}: ${raw.personal.roots.length} root(s)`, ...raw.personal.roots.map(line),
      ...raw.orgs.flatMap((o: any) => [`${o.hostname}${o.my_role ? ` · ${o.my_role}` : ""}: ${o.roots.length} root(s)`, ...o.roots.map(line)]),
      `Shared with you: ${raw.shared_with_me.length} root(s)`, ...raw.shared_with_me.map(line),
    ].join("\n");
    // The service's answer, unchanged: personal, orgs and shared_with_me.
    return { data: { schema: "ideaspaces.vaults.v1", ...raw }, text };
  });
}

/** Same per-Thread Unread data as the web; filtering never recalculates counts. */
export async function hostedListPage(config: ApiConfig, query: { limit: number; cursor?: string }) {
  const raw: any = await listHostedThreads(config, query);
  requireValue(record(raw) && Array.isArray(raw.threads) && raw.threads.length <= query.limit && (raw.next_cursor === null || typeof raw.next_cursor === "string"));
  const threads = raw.threads.map((t: any) => {
    requireValue(record(t) && typeof t.thread_id === "string" && HOSTED_THREAD_ID.test(t.thread_id) && typeof t.name === "string" && typeof t.closed === "boolean" && seq(t.unread_count));
    return { id: t.thread_id, name: t.name, closed: t.closed, unread_count: t.unread_count,
      ...(typeof t.summary === "string" ? { summary: t.summary } : {}),
      ...(seq(t.read_seq) ? { read_seq: t.read_seq } : {}), ...(seq(t.last_seq) ? { last_seq: t.last_seq } : {}),
      ...(typeof t.last_post_at === "string" ? { last_post_at: t.last_post_at } : {}) };
  });
  return { threads, next_cursor: raw.next_cursor as string | null };
}

export async function listVerb(output: Output, json: boolean, flags: Record<string, string | boolean>): Promise<number> {
  return runHosted(output, json, "Listing hosted Threads", "thread", async (config) => {
    const limit = pageLimit(flags.limit);
    const given = str(flags, "cursor");
    const cursor = given === undefined ? undefined : String(decode(config, given, ["list"]).value);
    const raw = await hostedListPage(config, { limit, ...(cursor ? { cursor } : {}) });
    const threads = raw.threads.filter((t: any) => !(flags.new || flags.unread) || t.unread_count > 0);
    const next = raw.next_cursor ? encode(config, "list", raw.next_cursor) : null;
    const text = threads.length
      ? threads.map((t: any) => `${t.id}  ${t.name}${t.closed ? " · closed" : ""}${t.unread_count ? ` · ${t.unread_count} unread` : ""}`).join("\n")
        + (next ? `\n\nMore: ideaspaces threads list --hosted --cursor ${next}` : "")
      : "No hosted Threads.";
    return { data: { schema: "ideaspaces.hosted-threads.list.v1", threads, cursor: next }, text };
  });
}

export async function openVerb(output: Output, json: boolean, id: string, flags: Record<string, string | boolean>): Promise<number> {
  return runHosted(output, json, "Reading hosted Threads", "thread", async (config) => {
    const limit = pageLimit(flags.limit);
    const given = str(flags, "cursor");
    const cursor = given === undefined ? undefined : decode(config, given, ["older", "follow"], id);
    const h = await head(config, id);
    let rows: HostedPost[];
    let next: number;
    let refresh = false;
    let hasMore = false;
    if (cursor?.kind === "follow") {
      const after = Number(cursor.value);
      rows = await posts(config, id, { limit, after_seq: after });
      // Edits and valid marks consume seq but are folded out of the page. Once a page is
      // drained, advance to the pre-read head, not just the last visible post. Never skip a full page.
      next = rows.length === limit ? rows.at(-1)!.seq : Math.max(after, h.lastSeq, rows.at(-1)?.seq ?? 0);
      refresh = h.lastSeq > after || rows.length > 0;
      hasMore = rows.length === limit;
    } else {
      const before = cursor ? Number(cursor.value) : undefined;
      rows = await posts(config, id, { limit, ...(before !== undefined ? { before_seq: before } : {}) });
      // A page read may race a new append after the head: never move its cursor backwards.
      next = Math.max(h.lastSeq, rows.at(-1)?.seq ?? 0);
    }
    const older = rows.length === limit && rows[0].seq > 1 ? encode(config, "older", rows[0].seq, id) : null;
    const follow = encode(config, "follow", next, id);
    const status = `${h.thread.closed ? "closed" : "open"} · ${h.thread.grade}${h.thread.can_reply ? "" : " · read only"}${knockStatus(h.thread.knock)}`;
    const text = [
      `${id}  ${h.thread.name}\n${status}`,
      ...rows.map(postText),
      [older && `Older: ideaspaces threads open ${id} --cursor ${older}`, `Newer: ideaspaces threads open ${id} --cursor ${follow}`, `Mark read: ideaspaces threads ack ${id} --cursor ${follow}`].filter(Boolean).join("\n"),
    ].join("\n\n");
    return { data: { schema: "ideaspaces.hosted-thread.page.v1", thread: h.thread, posts: rows, older_cursor: older, cursor: follow, refresh, has_more: hasMore }, text };
  }, { namesThread: true });
}

export async function postVerb(output: Output, json: boolean, id: string, flags: Record<string, string | boolean>): Promise<number> {
  // Validate before any credential is touched or anything is sent.
  const parents = str(flags, "reply-to")?.split(",").map((p) => p.trim());
  if (!parents?.length || parents.some((p) => !POST_ID.test(p)) || new Set(parents).size !== parents.length || parents.length > 16) {
    if (parents?.some(p => p.startsWith("n_"))) throw new HostedError("invalid_request", "Old n_ post ids are not /threads post ids. Read the ported Thread and use its returned msg_ id in --reply-to; no id was converted.");
    throw new HostedError("invalid_request", "--reply-to must name one to 16 distinct msg_ post ids in this Thread, separated by commas.");
  }
  const body = messageBody(flags);
  const name = singleLine(flags, "name", false);
  const summary = singleLine(flags, "summary", false);
  const msgId = postId(flags);
  const note = buildNote({ id: msgId, kind: "post", in_reply_to: parents.length === 1 ? parents[0] : parents, ...(name ? { name } : {}), ...(summary ? { summary } : {}), ...hostedMap(flags), ...hostedTags(flags) }, body);
  const parsed = parseThreadPost(note, "reply.md");
  if (!(parsed.status === "valid" && parsed.post.id === msgId && parsed.post.kind === "post" && parsed.post.inReplyTo.length > 0 && parsed.post.body.trim())) {
    throw new HostedError("invalid_request", "The reply Note did not validate; check --reply-to, --name, --summary and --message.");
  }
  return runHosted(output, json, "Posting to hosted Threads", "thread", async (config) => {
    const posted = postOf(await appendHostedThreadPost(config, id, note), id);
    requireValue(posted.id === msgId);
    return { data: { schema: "ideaspaces.hosted-thread.post.v1", thread_id: id, post: posted }, text: `Posted ${posted.id} as seq ${posted.seq} in ${id} (${posted.author}).` };
  }, { retry: { postId: msgId, verb: "post" }, namesThread: true });
}

export async function newVerb(output: Output, json: boolean, flags: Record<string, string | boolean>): Promise<number> {
  // This slice admits Map placement only; other server home kinds are not CLI Spaces.
  const home = str(flags, "home");
  if (flags.home !== undefined && (!home?.startsWith("map:") || !NODE_ID.test(home.slice(4)))) {
    throw new HostedError("invalid_request", "--home needs map:<map-id>. It places the Thread in a hosted Space; it grants no content access.");
  }
  const recipients = str(flags, "recipients")?.split(",").map((r) => r.trim()) ?? [];
  if (recipients.length > 16 || recipients.some((r) => !/^@[A-Za-z0-9_.-]+$/.test(r) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) || new Set(recipients.map((r) => r.toLowerCase())).size !== recipients.length) {
    throw new HostedError("invalid_request", "--recipients needs up to 16 distinct @handles or email addresses, comma-separated.");
  }
  const name = singleLine(flags, "name", true)!;
  const summary = singleLine(flags, "summary", true)!;
  const body = messageBody(flags);
  const msgId = postId(flags);
  const note = buildNote({ id: msgId, kind: "post", name, summary, ...hostedMap(flags), ...hostedTags(flags) }, body);
  const parsed = parseThreadPost(note, "opening.md");
  if (!(parsed.status === "valid" && parsed.post.id === msgId && parsed.post.inReplyTo.length === 0)) {
    throw new HostedError("invalid_request", "The opening Note did not validate; check --name, --summary and --message.");
  }
  return runHosted(output, json, "Opening hosted Threads", "thread", async (config) => {
    const raw: any = await openHostedThread(config, note, recipients, home ? { homeRef: home } : undefined);
    requireValue(record(raw) && typeof raw.thread_id === "string" && HOSTED_THREAD_ID.test(raw.thread_id));
    const opening = postOf(raw, raw.thread_id);
    // A knock already open answers with its own first post, so only a knock may carry another id.
    const knocked = raw.reach === "knocked";
    requireValue(opening.seq === 1 && (knocked || opening.id === msgId));
    const reach = typeof raw.reach === "string" ? { reach: raw.reach } : {};
    const data = { schema: "ideaspaces.hosted-thread.new.v1", thread_id: raw.thread_id, ...reach, post: opening };
    if (!knocked) return { data, text: `Opened ${raw.thread_id}: ${name}` };
    // The service names a knock, so the form's name is not what they see.
    const title = typeof opening.fields.name === "string" ? opening.fields.name : "A knock";
    const stored = opening.id === msgId;
    const who = recipients[0] ?? "them";
    const lines = stored
      ? [`Knocked on ${who}: ${raw.thread_id}  ${title}`, "They see your message and can let you in or decline. Neither of you can post until they let you in."]
      : [`You already have a knock open with ${who}: ${raw.thread_id}  ${title}`, "This message was not stored. They still see your first one, and neither of you can post until they let you in."];
    return { data: { ...data, message_stored: stored }, text: [...lines, `See where it stands: ideaspaces threads open ${raw.thread_id}`].join("\n") };
  }, { retry: { postId: msgId, verb: "new" } });
}

/** Lifecycle is an immutable Note on /threads, not an exchange management route. */
export async function lifecycleVerb(output: Output, json: boolean, id: string, verb: "close" | "rename", flags: Record<string, string | boolean>, confirmed: boolean): Promise<number> {
  const name = verb === "rename" ? singleLine(flags, "name", true)! : undefined;
  const summary = verb === "rename" ? singleLine(flags, "summary", true)! : undefined;
  const body = messageBody(flags);
  const msgId = postId(flags);
  const note = buildNote({ id: msgId, kind: verb === "close" ? "closure" : "reframe", ...(name ? { name, summary } : {}) }, body);
  if (verb === "close" && !confirmed) {
    output.result({ schema: "ideaspaces.hosted-thread.close-preview.v1", preview: true, thread_id: id, post_id: msgId, note, access_checked: false }, `Close ${id}? Local preview only; access has not been checked. This appends a closure Note and stops new replies. Re-run with --yes --post-id ${msgId} and the same --message to confirm.`);
    return 0;
  }
  return runHosted(output, json, `${verb === "close" ? "Closing" : "Renaming"} hosted Threads`, "thread", async (config) => {
    const posted = postOf(await appendHostedThreadPost(config, id, note), id);
    requireValue(posted.id === msgId);
    return { data: { schema: "ideaspaces.hosted-thread.post.v1", thread_id: id, post: posted }, text: `${verb === "close" ? "Closed" : "Renamed"} ${id} (${posted.id}).` };
  }, { retry: { postId: msgId, verb }, namesThread: true });
}

export async function ackVerb(output: Output, json: boolean, id: string, flags: Record<string, string | boolean>): Promise<number> {
  const given = str(flags, "cursor");
  const rawSeq = str(flags, "seq");
  if ((given === undefined) === (rawSeq === undefined)) {
    throw new HostedError("invalid_request", "threads ack needs exactly one of --cursor <cursor from threads open> or --seq <n>.");
  }
  if (rawSeq !== undefined && !/^\d+$/.test(rawSeq)) throw new HostedError("invalid_request", "--seq must be a whole number.");
  return runHosted(output, json, "Marking hosted Threads read", "thread", async (config) => {
    const target = given !== undefined ? Number(decode(config, given, ["follow"], id).value) : Number(rawSeq);
    requireValue(seq(target), "invalid_request");
    const raw: any = await ackHostedThread(config, id, target);
    requireValue(record(raw) && raw.thread_id === id && seq(raw.read_seq));
    return { data: { schema: "ideaspaces.hosted-thread.ack.v1", thread_id: id, read_seq: raw.read_seq }, text: `Read up to seq ${raw.read_seq} in ${id}.` };
  });
}

/** For a refusal raised before any request (bad flags): print it the same way. */
export function reportHostedRefusal(error: unknown, output: Output, json: boolean): number | undefined {
  if (!(error instanceof HostedError)) return undefined;
  const message = error.message === error.state ? messages(error.state, "thread") : error.message;
  if (json) process.stdout.write(JSON.stringify({ schema: "ideaspaces.hosted.error.v1", error: { state: error.state, message } }, null, 2) + "\n");
  output.error(`Error (${error.state}): ${message}`);
  return 1;
}
