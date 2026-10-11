import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import {
  acknowledgeSubscription,
  addExchangePerson,
  addPersonShare,
  closeExchange,
  apiErrorDetail,
  describeShareRefusal,
  fetchExchange,
  fetchExchangeMapMember,
  fetchInbox,
  fetchSpaceThreads,
  fetchSubscriptionEvents,
  fetchThreadPosts,
  listSubscriptions,
  replyToExchange,
  renameExchange,
  sendInquiry,
  UnauthorizedError,
  type ExchangeMapMemberResponse,
  type ExchangeMessage,
  type ExchangeMessageSummary,
  type ExchangeManagementResponse,
  type ExchangeNoteWrite,
  type ExchangeReadResponse,
  type ExchangeWriteResponse,
  type FollowEvent,
  type InboxItem,
  type InboxParticipant,
  type InquiryInboxItem,
  type InquirySendBody,
  type PersonShareAddResult,
  type ShareGrade,
  type ThreadGrade,
  type ThreadPostSummary,
  type ThreadPostsPageResponse,
  type ThreadPostsQuery,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import {
  formatPortableMap,
  memberReference,
  parseExchangeMapSelection,
  type ExchangeMapSelection,
} from "../exchange-map-selection.js";
import { reconstructThreadTimeline, type ThreadNode, type ThreadPost } from "@ideaspaces/protocol";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";
import { appendAddressMemberToMapFile } from "./map-edit.js";
import { humanGrade, parseGrade } from "./request.js";
import { HOSTED_THREAD_ID as HOSTED, NODE_ID, threadFlagError, type Flags } from "./thread-flags.js";

const USAGE = "ideaspaces threads <list|posts|read|send|reply|add|close|rename|expand> ...";
const LIST_USAGE =
  "ideaspaces threads list [--space <space_node_id>] [--new|--since <position>] [--kind <message|reframe|request|post>] [--depth <name|summary|full>]";
const POSTS_USAGE =
  "ideaspaces threads posts [x_thread_id] [--space <space_node_id>] [--scope <inbox|followed>] [--limit <number>] [--since <position|note_node_id|ISO date>] [--depth <name|summary>] [--order <newer|older>] [--cursor <token>]";
const READ_USAGE =
  "ideaspaces threads read <thread_id> [--new|--since <position|ISO date|note_node_id>] [--post <note_node_id>] [--kind <message|reframe>] [--depth <name|summary|children|surface|full>] [--ack]";
const SEND_USAGE =
  "ideaspaces threads send [<email|@handle>] [--space <space_node_id>] [--about <node_id>] [--map <selection.json>] [--share <viewer|copying|editor>] [--share-roots <node_id,...>] [--space-map <path.map.md>] [--grade <view|participate>] --name <title> --summary <summary> [--message <markdown>] [--send-id <id>] (recipient required without a target)";
const EXPAND_USAGE = "ideaspaces threads expand <thread_id> <member_ordinal>";
const MAX_SELECTION_FILE_BYTES = 128 * 1024;
const REPLY_USAGE =
  "ideaspaces threads reply <thread_id> [--reply-to <node_id,...>] [--map <selection.json>] --name <title> --summary <summary> [--message <markdown>] [--send-id <id>]";

function flagString(flags: Flags, name: string): string | undefined {
  return typeof flags[name] === "string" ? flags[name] : undefined;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function recipientSelector(value: string): InquirySendBody["recipient"] | null {
  if (value.startsWith("@") && value.length > 1 && !value.slice(1).includes("@")) {
    return { username: value.slice(1) };
  }
  if (!value.startsWith("@") && value.includes("@")) {
    return { email: value };
  }
  return null;
}

function threadGrade(flags: Flags, output: Output): "view" | "participate" | null {
  if (flags.grade === undefined) return "participate";
  if (flags.grade === "view" || flags.grade === "participate") return flags.grade;
  output.error("--grade must be view or participate; manage is reserved for the Thread owner.");
  return null;
}

async function writeBody(flags: Flags, output: Output): Promise<ExchangeNoteWrite | null> {
  const name = flagString(flags, "name")?.trim();
  const summary = flagString(flags, "summary")?.trim();
  if (!name) {
    output.error("--name <title> is required.");
    return null;
  }
  if (!summary) {
    output.error("--summary <summary> is required.");
    return null;
  }
  const markdown = flagString(flags, "message") ?? await readStdin();
  if (!markdown.trim()) {
    output.error("A message is required through --message or stdin.");
    return null;
  }
  return {
    send_id: flagString(flags, "send-id")?.trim() || `cli_${randomUUID()}`,
    name,
    summary,
    markdown,
  };
}

function loadMapSelection(flags: Flags, output: Output): ExchangeMapSelection | null | undefined {
  const path = flagString(flags, "map");
  if (flags.map === undefined) return undefined;
  if (!path) {
    output.error("--map requires a selection file path.");
    return null;
  }
  try {
    if (statSync(path).size > MAX_SELECTION_FILE_BYTES) {
      throw new Error(`selection file exceeds ${MAX_SELECTION_FILE_BYTES} bytes`);
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseExchangeMapSelection(raw);
  } catch (error) {
    output.error(`Could not load --map selection: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function participantLabel(participant: InboxParticipant): string {
  return participant.name ?? participant.username ?? participant.participant;
}

function participantsText(participants: InboxParticipant[]): string {
  return participants.map(participantLabel).join(", ");
}

type InboxKind = "message" | "reframe" | "request" | "post";
type ReadDepth = "name" | "summary" | "children" | "surface" | "full";

export function threadBadges(grade?: ThreadGrade, closed?: boolean): string {
  return `${grade ? ` [${grade}]` : ""}${closed ? " [closed]" : ""}`;
}

function isInquiry(item: InboxItem): item is InquiryInboxItem {
  return item.kind === "inquiry";
}

function inboxItemName(item: InboxItem): string {
  if (isInquiry(item)) return `${item.exchange_id}  ${item.name ?? item.latest_message.name}${threadBadges(item.your_grade, item.closed)}`;
  return `${item.request_id}  Access request for ${item.target_node_id}`;
}

function inboxItemText(item: InboxItem): string {
  if (!isInquiry(item)) {
    return [
      inboxItemName(item),
      `  ${participantLabel(item.requester)} requests ${item.requested_grade}`,
      ...(item.reason ? [`  ${item.reason}`] : []),
    ].join("\n");
  }
  const count = `${item.message_count} ${item.message_count === 1 ? "message" : "messages"}`;
  const cursor = item.cursor === null ? "not followed" : `cursor ${item.cursor}`;
  return [
    inboxItemName(item),
    `  ${item.latest_message.summary}`,
    `  ${item.target_node_id ? `about ${item.target_node_id} · ` : ""}${count} · ${cursor} · ${participantsText(item.participants)}`,
  ].join("\n");
}

/**
 * Resolves effective in_reply_to parent IDs for a hosted message.
 * Pre-#1017 messages did not persist in_reply_to on the server (empty array);
 * to ensure a connected disclosure tree, legacy replies fall back to the opening note.
 */
export function effectiveInReplyTo(message: ExchangeMessageSummary, openingId?: string): string[] {
  if (message.note_node_id === openingId) {
    return message.in_reply_to ?? [];
  }
  if (message.in_reply_to && message.in_reply_to.length > 0) {
    return message.in_reply_to;
  }
  return openingId ? [openingId] : [];
}

export function isInferredParent(message: ExchangeMessageSummary, openingId?: string): boolean {
  return !!openingId && message.note_node_id !== openingId && !message.in_reply_to?.length;
}

export interface HostedThreadChild {
  id: string;
  note_node_id: string;
  kind: string;
  date: string | null;
  name: string;
  in_reply_to: string[];
  in_reply_to_inferred?: true;
  children: HostedThreadChild[];
}

export function hostedToThreadPosts(messages: ExchangeMessage[], openingId?: string): ThreadPost[] {
  return messages.map((m) => ({
    id: m.note_node_id,
    // ThreadPost is used only for the protocol timeline; hosted actions are not local Thread kinds.
    kind: "post" as const,
    date: m.created_at,
    inReplyTo: effectiveInReplyTo(m, openingId),
    references: [],
    frontmatter: { id: m.note_node_id, name: m.name, summary: m.summary },
    body: m.markdown,
    path: `${String(m.position).padStart(8, "0")}-${m.note_node_id}`,
  }));
}

export function hostedChildTree(messages: ExchangeMessage[], openingId?: string): HostedThreadChild[] {
  const posts = hostedToThreadPosts(messages, openingId);
  const byId = new Map(messages.map((message) => [message.note_node_id, message]));
  const nodeMap = new Map<string, ThreadNode>();
  for (const post of posts) {
    nodeMap.set(post.id, { post, parents: [...post.inReplyTo], children: [] });
  }
  for (const post of posts) {
    const childNode = nodeMap.get(post.id)!;
    for (const pId of post.inReplyTo) {
      const parentNode = nodeMap.get(pId);
      if (parentNode) parentNode.children.push(childNode);
    }
  }

  const seen = new Set<string>();
  function project(node: ThreadNode): HostedThreadChild {
    seen.add(node.post.id);
    const source = byId.get(node.post.id)!;
    const children: HostedThreadChild[] = [];
    for (const child of node.children) {
      if (!seen.has(child.post.id)) {
        children.push(project(child));
      }
    }
    return {
      id: node.post.id,
      note_node_id: node.post.id,
      kind: source.action,
      date: source.created_at,
      name: source.name,
      in_reply_to: node.post.inReplyTo,
      ...(isInferredParent(source, openingId) ? { in_reply_to_inferred: true as const } : {}),
      children,
    };
  }

  const timeline = reconstructThreadTimeline(posts);
  const roots: HostedThreadChild[] = [];
  for (const rootNode of timeline.roots) {
    if (!seen.has(rootNode.post.id)) {
      roots.push(project(rootNode));
    }
  }
  for (const post of timeline.posts) {
    if (!seen.has(post.id)) {
      const node = nodeMap.get(post.id);
      if (node) roots.push(project(node));
    }
  }
  return roots;
}

export function formatHostedChildrenText(roots: HostedThreadChild[]): string {
  const lines: string[] = [];
  function visit(nodes: HostedThreadChild[], indent: number) {
    for (const node of nodes) {
      const parentList = (node.in_reply_to.join(", ") || "—") + (node.in_reply_to_inferred ? " (inferred)" : "");
      const dateText = node.date ?? "undated";
      lines.push(
        `${"  ".repeat(indent)}${node.note_node_id} · ${node.kind} · ${dateText} · ${node.name} · in_reply_to ${parentList}`,
      );
      visit(node.children, indent + 1);
    }
  }
  visit(roots, 0);
  return lines.join("\n");
}

export function exchangeText(
  exchange: ExchangeReadResponse,
  messages: ExchangeMessage[] = exchange.messages,
  depth: ReadDepth = "full",
): string {
  const current = exchange.messages.find(
    (message) => message.note_node_id === exchange.subject?.current_note_id,
  ) ?? exchange.messages.at(-1);
  if (depth === "name") return `${exchange.exchange_id}  ${exchange.name ?? current?.name ?? "Thread"}${threadBadges(exchange.your_grade, exchange.closed)}`;

  const lines = [
    `Thread ${exchange.exchange_id}${threadBadges(undefined, exchange.closed)}`,
    ...(exchange.your_grade ? [`Your grade: ${exchange.your_grade}`] : []),
    ...(exchange.target_node_id ? [`About ${exchange.target_node_id}`] : []),
    `Participants: ${participantsText(exchange.participants)}`,
    `Cursor: ${exchange.cursor ?? "not followed"} · Latest: ${exchange.latest_position}`,
  ];
  for (const message of messages) {
    const author = exchange.participants.find(
      (participant) => participant.participant === message.author_ref,
    );
    const actor = message.actor_ref === message.author_ref ? "" : ` via ${message.actor_ref}`;
    lines.push(
      "",
      `[${message.position}] ${message.note_node_id} · ${message.action} · ${message.created_at} · ${author ? participantLabel(author) : message.author_ref}${actor} — ${message.name}`,
      message.summary,
    );
    if (depth === "full") {
      if (message.map) lines.push(...formatPortableMap(message.map));
      lines.push(message.markdown);
    }
  }
  return lines.join("\n");
}

function parsePosition(value: string | boolean | undefined, output: Output): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    output.error("--since must be a non-negative integer position.");
    return null;
  }
  const position = Number(value);
  if (!Number.isSafeInteger(position)) {
    output.error("--since must be a non-negative safe integer position.");
    return null;
  }
  return position;
}

function parseKind(value: string | boolean | undefined, output: Output): InboxKind | null | undefined {
  if (value === undefined) return undefined;
  if (value === "message" || value === "reframe" || value === "request" || value === "post") return value;
  output.error("--kind must be one of: message, reframe, request, post.");
  return null;
}

function parseDepth(value: string | boolean | undefined, output: Output): ReadDepth | null {
  if (value === undefined) return "summary";
  if (value === "name" || value === "summary" || value === "children" || value === "surface" || value === "full") return value;
  output.error("--depth must be one of: name, summary, children, surface, full.");
  return null;
}

function validateTemporalFlags(flags: Flags, output: Output): boolean {
  if (flags.new !== undefined && flags.new !== true) {
    output.error("--new does not take a value.");
    return false;
  }
  if (flags.new && flags.since !== undefined) {
    output.error("Use either --new or --since, not both.");
    return false;
  }
  return true;
}

async function boundedSubscriptionEvents(
  config: NonNullable<ReturnType<typeof loadConfig>>,
): Promise<FollowEvent[]> {
  const events = await fetchSubscriptionEvents(config, 1_000);
  if (events.length === 1_000) {
    throw new Error(
      "The new-event view reached its 1,000-event safety bound. Acknowledge a known position or narrow the followed sources before reading reframes.",
    );
  }
  return events;
}

async function runAuthenticated(
  output: Output,
  operation: (config: NonNullable<ReturnType<typeof loadConfig>>) => Promise<number>,
): Promise<number> {
  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return 1;
  }
  try {
    return await operation(config);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      output.error("Session expired. Run `ideaspaces login`.");
      return 1;
    }
    output.error(apiErrorDetail(err));
    return 1;
  }
}

async function list(rest: string[], flags: Flags, output: Output): Promise<number> {
  if (rest.length) {
    output.error(`Usage: ${LIST_USAGE}`);
    return 1;
  }
  const space = flagString(flags, "space")?.trim();
  if (space !== undefined && !NODE_ID.test(space)) {
    output.error("Invalid --space: must be a Space node_id (n_…).");
    return 1;
  }
  if (space && (flags.new || flags.since !== undefined || flags.kind !== undefined)) {
    output.error("--space lists coordination Space threads and cannot be combined with --new, --since, or --kind.");
    return 1;
  }
  if (!validateTemporalFlags(flags, output)) return 1;
  const since = parsePosition(flags.since, output);
  if (since === null) return 1;
  const kind = parseKind(flags.kind, output);
  if (kind === null) return 1;
  if (kind === "post") {
    if (flags.new) {
      output.error("--new cannot be combined with --kind post; use ideaspaces threads posts with --since or cursor pagination.");
      return 1;
    }
    return posts(rest, flags, output);
  }
  if (flags.new && kind === "request") {
    output.error("--new cannot be combined with --kind request because access requests have no followed cursor. Use --kind request, optionally with --since <position>.");
    return 1;
  }
  const depth = parseDepth(flags.depth, output);
  if (!depth) return 1;
  if (depth === "children" || depth === "surface") {
    output.error("--depth children and surface are for opening a Thread; list supports name, summary or full.");
    return 1;
  }

  return runAuthenticated(output, async (config) => {
    if (space) {
      const response = await fetchSpaceThreads(config, space);
      const threads = response.threads;
      let text: string;
      if (!threads.length) {
        text = `No threads in Space ${space}.`;
      } else if (depth === "name") {
        text = threads.map((t) => `${t.exchange_id}  ${t.name}`).join("\n");
      } else if (depth === "full") {
        const blocks = await Promise.all(
          threads.map(async (t) => {
            if (!t.can_read) {
              return `${t.exchange_id}  ${t.name}\n  ${t.summary}\n  revision ${t.revision} · not open to you\n  [Not open to you]`;
            }
            try {
              const exchange = await fetchExchange(config, t.exchange_id);
              return exchangeText(exchange, exchange.messages, "full");
            } catch (err) {
              if (err instanceof UnauthorizedError) throw err;
              return `${t.exchange_id}  ${t.name}\n  ${t.summary}\n  revision ${t.revision} · ${apiErrorDetail(err)}`;
            }
          }),
        );
        text = blocks.join("\n\n");
      } else {
        text = threads
          .map(
            (t) =>
              `${t.exchange_id}  ${t.name}\n  ${t.summary}\n  revision ${t.revision} · ${t.can_read ? "readable" : "not open to you"}`,
          )
          .join("\n\n");
      }
      output.result({ threads }, text);
      return 0;
    }

    const inbox = await fetchInbox(config);
    let reframeNoteIds: Map<string, Set<string>> | undefined;
    let items = inbox.items.filter((item) => since === undefined || item.latest_position > since);
    if (flags.new) {
      items = items.filter((item) => isInquiry(item) && item.cursor !== null && item.latest_position > item.cursor);
    }
    if (kind === "message") items = items.filter(isInquiry);
    if (kind === "request") items = items.filter((item) => !isInquiry(item));
    if (kind === "reframe") {
      reframeNoteIds = new Map();
      for (const event of await boundedSubscriptionEvents(config)) {
        if (event.action !== "thread.reframed" || !event.exchange_id || !event.note_node_id) continue;
        const noteIds = reframeNoteIds.get(event.exchange_id) ?? new Set<string>();
        noteIds.add(event.note_node_id);
        reframeNoteIds.set(event.exchange_id, noteIds);
      }
      items = items.filter((item) => isInquiry(item) && reframeNoteIds?.has(item.exchange_id));
    }

    let text: string;
    if (!items.length) {
      text = flags.new ? "No new followed Threads." : "Inbox is empty.";
    } else if (depth === "name") {
      text = items.map(inboxItemName).join("\n");
    } else if (depth === "full") {
      const blocks = await Promise.all(items.map(async (item) => {
        if (!isInquiry(item)) return inboxItemText(item);
        const exchange = await fetchExchange(config, item.exchange_id);
        const noteIds = reframeNoteIds?.get(item.exchange_id);
        const messages = noteIds
          ? exchange.messages.filter((message) => noteIds.has(message.note_node_id))
          : exchange.messages;
        return exchangeText(exchange, messages, "full");
      }));
      text = blocks.join("\n\n");
    } else {
      text = items.map(inboxItemText).join("\n\n");
    }
    output.result({ items }, text);
    return 0;
  });
}

async function read(rest: string[], flags: Flags, output: Output): Promise<number> {
  const [exchangeId] = rest;
  if (!exchangeId || rest.length !== 1) {
    output.error(`Usage: ${READ_USAGE}`);
    return 1;
  }
  if (!validateTemporalFlags(flags, output)) return 1;
  if (flags.ack !== undefined && flags.ack !== true) {
    output.error("--ack does not take a value here; use `ideaspaces follow thread <id> --ack <position>` to acknowledge an exact position.");
    return 1;
  }
  if (flags.ack && (flags.since !== undefined || flags.post !== undefined || flags.depth === "name" || flags.depth === "children")) {
    output.error("--ack requires an unfiltered summary or full read; omit --since, --post and name/children depth because omitted events would be marked read. Use follow --ack <position> for an exact cursor.");
    return 1;
  }
  if (flags.post !== undefined && (flags.new || flags.since !== undefined)) {
    output.error("--post selects one immutable Note; omit --new and --since, which select a range.");
    return 1;
  }
  const sinceValue = flagString(flags, "since");
  if (flags.since !== undefined && (!sinceValue || !( /^\d+$/.test(sinceValue) || /^n_[a-zA-Z0-9_-]+$/.test(sinceValue) || /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(sinceValue)))) {
    output.error("--since needs a position, hosted Note id, or ISO date.");
    return 1;
  }
  const post = flagString(flags, "post");
  if (flags.post !== undefined && !post) {
    output.error("--post needs a hosted Note id (n_…).");
    return 1;
  }
  const kind = parseKind(flags.kind, output);
  if (kind === null) return 1;
  if (kind === "request") {
    output.error("Access requests are Inbox items, not Thread messages; use `inbox list --kind request`.");
    return 1;
  }
  if (kind === "reframe" && flags.ack) {
    output.error("--ack cannot be combined with --kind reframe because hidden message events would be marked read. Read reframes without acknowledgement, or acknowledge an exact position with `follow --ack`.");
    return 1;
  }
  const depth = parseDepth(flags.depth ?? "full", output);
  if (!depth) return 1;
  if (depth === "surface" && !post) {
    output.error("Hosted Thread surface needs --post <note_node_id> to select one post.");
    return 1;
  }
  if (kind === "reframe" && sinceValue && !/^\d+$/.test(sinceValue)) {
    output.error("--kind reframe needs a numeric --since position; the bounded event feed has no post-id or date cursor.");
    return 1;
  }

  return runAuthenticated(output, async (config) => {
    const exchange = await fetchExchange(config, exchangeId);
    const since = sinceValue && /^\d+$/.test(sinceValue) ? Number(sinceValue) : undefined;
    if (since !== undefined && !Number.isSafeInteger(since)) {
      output.error("--since position must be a non-negative safe integer.");
      return 1;
    }
    if (sinceValue && since === undefined && /^n_/.test(sinceValue) && !exchange.messages.some((message) => message.note_node_id === sinceValue)) {
      output.error(`--since post ${sinceValue} is not in Thread ${exchangeId}.`);
      return 1;
    }
    const sinceDate = sinceValue && /^\d{4}-/.test(sinceValue) ? Date.parse(sinceValue) : undefined;
    if (sinceDate !== undefined && Number.isNaN(sinceDate)) {
      output.error("--since must be a valid ISO date.");
      return 1;
    }
    if ((flags.new || flags.ack) && exchange.cursor === null) {
      output.error(`Thread ${exchangeId} is not followed. Run \`ideaspaces follow thread ${exchangeId}\` first.`);
      return 1;
    }
    const after = flags.new ? exchange.cursor ?? undefined : since;
    const sincePost = sinceValue && /^n_/.test(sinceValue)
      ? exchange.messages.find((message) => message.note_node_id === sinceValue) : undefined;
    let messages = exchange.messages.filter((message) =>
      (after === undefined || message.position > after) &&
      (sincePost === undefined || message.position > sincePost.position) &&
      (sinceDate === undefined || Date.parse(message.created_at) > sinceDate),
    );
    if (post) {
      if (!exchange.messages.some((message) => message.note_node_id === post)) {
        output.error(`Post ${post} is not in Thread ${exchangeId}.`);
        return 1;
      }
      messages = messages.filter((message) => message.note_node_id === post);
    }
    let events: FollowEvent[] = [];
    if (kind === "reframe") {
      if (after !== undefined && exchange.cursor !== null && after < exchange.cursor) {
        output.error(
          `Reframe events before the stored cursor ${exchange.cursor} are no longer in the subscription read. Use --new or --since ${exchange.cursor} or later.`,
        );
        return 1;
      }
      events = (await boundedSubscriptionEvents(config)).filter(
        (event) => event.exchange_id === exchangeId &&
          event.action === "thread.reframed" &&
          (after === undefined || event.position > after),
      );
      const noteIds = new Set(events.map((event) => event.note_node_id));
      messages = exchange.messages.filter((message) => noteIds.has(message.note_node_id));
    }

    let acknowledged;
    if (flags.ack) {
      const rows = await listSubscriptions(config);
      const row = rows.find(
        (candidate) => candidate.source_kind === "exchange" && candidate.source_id === exchangeId,
      );
      if (!row) {
        output.error(`Thread ${exchangeId} is not followed.`);
        return 1;
      }
      acknowledged = await acknowledgeSubscription(config, row.id, exchange.latest_position);
    }

    const openingId = exchange.subject?.opening_note_id ?? exchange.messages[0]?.note_node_id;
    const projected = post || depth === "surface" || depth === "full" ? messages : depth === "name" ? [] : depth === "children" ? hostedChildTree(messages, openingId) : messages.map((message) => ({
      id: message.note_node_id, note_node_id: message.note_node_id, kind: message.action, date: message.created_at, name: message.name,
      ...(depth === "summary" ? { summary: message.summary, author: message.author_ref, in_reply_to: effectiveInReplyTo(message, openingId),
        ...(isInferredParent(message, openingId) ? { in_reply_to_inferred: true } : {}) } : {}),
    }));
    const data = {
      ...exchange,
      messages: projected,
      ...(kind === "reframe" ? { events } : {}),
      ...(acknowledged ? { acknowledged_cursor: acknowledged.cursor } : {}),
    };
    const empty = kind === "reframe" ? "No new reframe events." : "No messages after that position.";
    const text = depth === "children" && !post
      ? formatHostedChildrenText(projected as HostedThreadChild[])
      : exchangeText(exchange, messages, post ? "full" : depth);
    output.result(data, messages.length ? text : empty);
    return 0;
  });
}

async function send(rest: string[], flags: Flags, output: Output): Promise<number> {
  // Recipient is required when there is no subject Node. For targeted sends,
  // omitting it still addresses that Node's owner.
  const [recipientValue] = rest;
  const recipient = recipientValue ? recipientSelector(recipientValue) : undefined;
  const selection = loadMapSelection(flags, output);
  if (selection === null) return 1;
  const requestedTarget = flagString(flags, "about")?.trim();
  if (selection?.target_node_id && requestedTarget && requestedTarget !== selection.target_node_id) {
    output.error("--about does not match the reviewed Map selection target_node_id.");
    return 1;
  }
  const target = requestedTarget ?? selection?.target_node_id;
  const spaceId = flagString(flags, "space")?.trim();
  if (spaceId !== undefined && !NODE_ID.test(spaceId)) {
    output.error("Invalid --space: must be a Space node_id (n_…).");
    return 1;
  }
  const grade = threadGrade(flags, output);
  if (!grade) return 1;
  const shareArg = flagString(flags, "share") ?? (flags.share === true ? "viewer" : undefined);
  let parsedShareGrade: ShareGrade | undefined;
  if (shareArg) {
    const g = parseGrade(shareArg);
    if (!g) {
      output.error("Invalid --share grade: must be viewer (explore), copying (fork), or editor (collaborate).");
      return 1;
    }
    parsedShareGrade = g;
  }
  if (parsedShareGrade && !recipientValue) {
    output.error("Sharing requires an explicit recipient (@handle or email).");
    return 1;
  }
  if (rest.length > 1 || recipient === null) {
    output.error(`Usage: ${SEND_USAGE}`);
    return 1;
  }
  if (!target && !recipient) {
    output.error("Say who to send to: threads send @handle --name <title> --summary <summary> --message <markdown>.");
    return 1;
  }
  const explicitShareRoots = flagString(flags, "share-roots")?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
  if (parsedShareGrade && !explicitShareRoots.length && !target && !selection?.map.roots.length) {
    output.error("--share without a target or Map roots needs --share-roots <node_id,...>.");
    return 1;
  }
  const note = await writeBody(flags, output);
  if (!note) return 1;

  return runAuthenticated(output, async (config) => {
    const shareResults: Array<PersonShareAddResult & { root_node_id: string; message: string }> = [];
    if (parsedShareGrade && recipient) {
      let rootsToShare: string[] = [];
      if (explicitShareRoots.length) {
        rootsToShare = explicitShareRoots;
      } else if (selection?.map?.roots && selection.map.roots.length > 0) {
        rootsToShare = Array.from(
          new Set(
            selection.map.roots
              .map((r) => r.root_node_id)
              .filter((id): id is string => typeof id === "string" && Boolean(id)),
          ),
        );
      } else if (target) {
        rootsToShare = [target];
      }

      const email = recipient && "email" in recipient ? recipient.email : undefined;
      const username = recipient && "username" in recipient ? recipient.username : undefined;

      for (const rootNodeId of rootsToShare) {
        try {
          const shareRes = await addPersonShare(config, rootNodeId, {
            ...(email ? { email, invite_if_no_match: true } : {}),
            ...(username ? { username, invite_if_no_match: false } : {}),
            grade: parsedShareGrade,
          });
          let shareMsg: string;
          if (shareRes.status === "added") {
            shareMsg = `Shared ${rootNodeId} with ${recipientValue} at ${humanGrade(parsedShareGrade)}.`;
          } else if (shareRes.status === "already_direct") {
            shareMsg = `${recipientValue} already has direct access to ${rootNodeId}.`;
          } else if (shareRes.status === "invited" || shareRes.status === "already_pending") {
            shareMsg = `No account yet — invited ${recipientValue} at ${humanGrade(parsedShareGrade)} for ${rootNodeId}. They get access when they accept.`;
          } else if (shareRes.status === "self") {
            shareMsg = `You own ${rootNodeId}.`;
          } else {
            shareMsg = `Share status for ${rootNodeId}: ${shareRes.status}.`;
          }
          shareResults.push({ ...shareRes, root_node_id: rootNodeId, message: shareMsg });
        } catch (shareErr) {
          const shareErrMsg = `Failed to share ${rootNodeId} with ${recipientValue}: ${describeShareRefusal(shareErr) ?? apiErrorDetail(shareErr)}`;
          shareResults.push({
            target_node_id: rootNodeId,
            root_node_id: rootNodeId,
            grade: parsedShareGrade,
            status: "recipient_unavailable",
            share_history: false,
            recipient_route: "",
            message: shareErrMsg,
          });
        }
      }
    }

    let result: ExchangeWriteResponse;
    try {
      result = await sendInquiry(config, {
        ...note,
        ...(target ? { target_node_id: target } : {}),
        ...(recipient ? { recipient } : {}),
        ...(flags.grade !== undefined ? { grade } : {}),
        ...(spaceId ? { space_id: spaceId } : {}),
        ...(selection ? { map: selection.map } : {}),
      });
    } catch (sendErr) {
      const errDetail = apiErrorDetail(sendErr);
      if (!target && sendErr instanceof Error && /→ 422:/.test(sendErr.message) && /target_node_id/.test(sendErr.message)) {
        output.error("This server does not yet accept message-only Threads (target_node_id is still required). Wait for the API rollout, or pass --about <node_id> to send a targeted Thread now.");
        return 1;
      }
      if (
        errDetail.includes("recipient unavailable") ||
        errDetail.includes("no routable person owner") ||
        errDetail.includes("ExchangeRecipientUnavailableError")
      ) {
        const hasInvited = shareResults.some((r) => r.status === "invited" || r.status === "already_pending");
        const nextSteps = hasInvited
          ? `Next steps:\n- They must sign up at ideaspaces.xyz first; the invitation email has been sent for the shared root(s).\n- Once they sign up and accept, send the thread to them.`
          : `Next steps:\n- Have them sign up at ideaspaces.xyz first, or\n- Share a space or repo with them (\`ideaspaces share person ${recipientValue} --grade viewer\`), which sends an invitation email.`;
        const refusalMsg = `Cannot send thread to ${recipientValue}: ${recipientValue} does not have an IdeaSpaces account yet.\n${nextSteps}`;
        const outputLines = [...shareResults.map((r) => r.message), refusalMsg];
        output.error(outputLines.join("\n\n"));
        return 1;
      }
      if (shareResults.length > 0) {
        output.error([...shareResults.map((r) => r.message), errDetail].join("\n\n"));
        return 1;
      }
      output.error(errDetail);
      return 1;
    }

    let spaceMapAdded: { file: string; address: string } | undefined;
    const spaceMapArg = flagString(flags, "space-map");
    if (spaceMapArg) {
      try {
        await appendAddressMemberToMapFile(spaceMapArg, `thread:${result.exchange_id}`, "summary");
        spaceMapAdded = { file: spaceMapArg, address: `thread:${result.exchange_id}` };
      } catch (mapErr) {
        output.error(
          `Warning: Could not add thread to Space Map ${spaceMapArg}: ${mapErr instanceof Error ? mapErr.message : String(mapErr)}`,
        );
      }
    }

    const lines: string[] = [];
    for (const sr of shareResults) {
      lines.push(sr.message);
    }
    const inSpace = result.space_id ? ` in Space ${result.space_id}` : "";
    // The owner-routing branch is reachable only for a targeted send: the
    // recipient-required preflight above rules out an absent subject here.
    const addressed = recipient
      ? `Sent${inSpace}. Thread ${result.exchange_id}${result.target_node_id ? ` is about ${result.target_node_id}` : ""}.`
      : `Sent${inSpace} to the owner of ${result.target_node_id}. Thread ${result.exchange_id}.`;
    lines.push(addressed);
    if (spaceMapAdded) {
      lines.push(`Added ${spaceMapAdded.address} to Space Map ${spaceMapAdded.file}.`);
    }

    output.result(
      {
        ...result,
        ...(shareResults.length ? { share_results: shareResults } : {}),
        ...(spaceMapAdded ? { space_map_added: spaceMapAdded } : {}),
      },
      lines.join("\n\n"),
    );
    return 0;
  });
}

function expansionText(result: ExchangeMapMemberResponse, exchange: ExchangeReadResponse): string {
  const map = exchange.messages.find((message) => message.map)?.map;
  const roots = map?.roots ?? [];
  const lines = [
    `Member [${result.member_ordinal}] ${memberReference(result.member, roots)}`,
    `Declared ceiling: ${result.member.depth ?? "summary"}`,
    ...formatPortableMap({ roots, members: [result.member] }).slice(2),
    "Resolved representation:",
  ];
  const representation = result.representation;
  if (typeof representation.name === "string") lines.push(`  Name: ${representation.name}`);
  if (typeof representation.summary === "string") lines.push(`  Summary: ${representation.summary}`);
  if (typeof representation.surface === "string") lines.push("  Surface:", representation.surface);
  if (Array.isArray(representation.children)) {
    lines.push("  Children:");
    for (const child of representation.children) {
      if (child && typeof child === "object") {
        const item = child as Record<string, unknown>;
        lines.push(`    ${"#".repeat(Number(item.level) || 1)} ${String(item.name ?? "")} (${String(item.position ?? "")})`);
      }
    }
    if (Number(representation.children_omitted) > 0) {
      lines.push(`    … ${Number(representation.children_omitted)} omitted`);
    }
  }
  return lines.join("\n");
}

async function expand(rest: string[], output: Output): Promise<number> {
  const [exchangeId, rawOrdinal] = rest;
  if (!exchangeId || !rawOrdinal || rest.length !== 2 || !/^\d+$/.test(rawOrdinal)) {
    output.error(`Usage: ${EXPAND_USAGE}`);
    return 1;
  }
  const memberOrdinal = Number(rawOrdinal);
  if (!Number.isSafeInteger(memberOrdinal)) {
    output.error(`Usage: ${EXPAND_USAGE}`);
    return 1;
  }
  return runAuthenticated(output, async (config) => {
    const exchange = await fetchExchange(config, exchangeId);
    const map = exchange.messages.find((message) => message.map)?.map;
    const member = map?.members?.[memberOrdinal];
    const roots = map?.roots ?? [];

    try {
      const result = await fetchExchangeMapMember(config, exchangeId, memberOrdinal);
      if (!map || !map.members[result.member_ordinal]) {
        throw new Error("Exchange Map reference is unavailable");
      }
      const data = { ...result, map: { roots: map.roots, members: [result.member] } };
      output.result(data, expansionText(result, exchange));
      return 0;
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      if (member) {
        const targetNodeId =
          "root" in member && typeof member.root === "number" && roots[member.root]
            ? roots[member.root].root_node_id
            : undefined;
        const ref = memberReference(member, roots);
        const name =
          member.disclosure?.name ??
          member.name ??
          ("position" in member ? member.position : "member");
        const summary = member.disclosure?.summary ?? member.summary ?? "";
        const lines = [
          "You need access to read this member.",
          `Member [${memberOrdinal}] ${ref}`,
          `Declared ceiling: ${member.depth ?? "summary"}`,
          `Name: ${name}`,
        ];
        if (summary) lines.push(`Summary: ${summary}`);
        if (targetNodeId) {
          lines.push(
            "",
            "Request access with:",
            `  ideaspaces request ${targetNodeId} --grade viewer`,
          );
        }
        const data = {
          ok: false,
          status: "refused",
          reason: "you_need_access",
          member_ordinal: memberOrdinal,
          member,
          ...(targetNodeId ? { target_node_id: targetNodeId } : {}),
          map: { roots, members: [member] },
        };
        output.result(data, lines.join("\n"));
        return 0;
      }
      throw err;
    }
  });
}

async function reply(rest: string[], flags: Flags, output: Output): Promise<number> {
  const [exchangeId] = rest;
  if (!exchangeId || rest.length !== 1) {
    output.error(`Usage: ${REPLY_USAGE}`);
    return 1;
  }
  let replyTo: string[] | undefined;
  if (flags["reply-to"] !== undefined) {
    const raw = flags["reply-to"];
    const ids = typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (!ids.length || ids.some((id) => !NODE_ID.test(id))) {
      output.error("--reply-to must name one or more valid Note ids (n_…), separated by commas.");
      return 1;
    }
    replyTo = Array.from(new Set(ids));
  }
  const selection = loadMapSelection(flags, output);
  if (selection === null) return 1;
  const note = await writeBody(flags, output);
  if (!note) return 1;
  return runAuthenticated(output, async (config) => {
    const result = await replyToExchange(config, exchangeId, {
      ...note,
      ...(replyTo?.length ? { in_reply_to: replyTo } : {}),
      ...(selection ? { map: selection.map } : {}),
    });
    output.result(result, `Replied in thread ${result.exchange_id}.`);
    return 0;
  });
}

async function manage(sub: "add" | "close" | "rename", rest: string[], flags: Flags, output: Output, apply: boolean): Promise<number> {
  const [exchangeId, handle] = rest;
  if (!exchangeId || !/^x_[0-9a-f]{24}$/.test(exchangeId)) {
    output.error(`Use a hosted Thread id (x_…) with threads ${sub}. Local Threads have separate controls.`);
    return 1;
  }
  let recipient: InquirySendBody["recipient"] | null = null;
  let grade: "view" | "participate" | null = null;
  let name: string | undefined;
  if (sub === "add") {
    recipient = handle ? recipientSelector(handle) : null;
    if (rest.length !== 2 || !recipient || !handle?.startsWith("@")) {
      output.error("Usage: threads add <x_id> @handle [--grade view|participate]. Add a registered @handle, not an email address.");
      return 1;
    }
    grade = threadGrade(flags, output);
    if (!grade) return 1;
  } else if (sub === "close") {
    if (rest.length !== 1 || flags.message !== undefined || flags.grade !== undefined || flags.name !== undefined) {
      output.error("Usage: threads close <x_id>. Hosted close has no --message; use threads reply first if you want to explain why.");
      return 1;
    }
  } else {
    name = flagString(flags, "name")?.trim();
    if (rest.length !== 1 || !name || flags.grade !== undefined) {
      output.error("Usage: threads rename <x_id> --name <new title>.");
      return 1;
    }
  }
  if (sub !== "rename" && !apply) {
    const planned = sub === "add"
      ? `Would add ${handle} to hosted Thread ${exchangeId} at ${grade}. This grants Thread access.`
      : `Would close hosted Thread ${exchangeId}.`;
    output.result({ exchange_id: exchangeId, planned: true, ...(sub === "add" ? { recipient, grade } : {}) }, `${planned} Nothing changed; re-run with --yes to apply. The server checks ownership.`);
    return 0;
  }
  return runAuthenticated(output, async (config) => {
    try {
      let result: ExchangeManagementResponse;
      let done: string;
      switch (sub) {
        case "add":
          result = await addExchangePerson(config, exchangeId, recipient!, grade!);
          done = `now includes ${handle} at ${grade}`;
          break;
        case "close":
          result = await closeExchange(config, exchangeId);
          done = "closed";
          break;
        case "rename":
          result = await renameExchange(config, exchangeId, name!);
          done = `renamed to ${name}`;
          break;
      }
      output.result(result, `Thread ${exchangeId} ${done}.`);
      return 0;
    } catch (error) {
      output.error(`Cannot ${sub} Thread ${exchangeId}: ${apiErrorDetail(error)}`);
      return 1;
    }
  });
}

async function posts(rest: string[], flags: Flags, output: Output): Promise<number> {
  if (rest.length > 1) {
    output.error(`Usage: ${POSTS_USAGE}`);
    return 1;
  }
  const threadId = rest[0]?.trim();
  if (threadId && !HOSTED.test(threadId)) {
    output.error(`Invalid thread ID: ${threadId}. Expected x_ followed by 24 hex characters.`);
    return 1;
  }
  const space = flagString(flags, "space")?.trim();
  if (space !== undefined && !NODE_ID.test(space)) {
    output.error("Invalid --space: must be a Space node_id (n_…).");
    return 1;
  }
  const scopeRaw = flagString(flags, "scope")?.trim();
  let scopeVal: "inbox" | "followed" | undefined;
  if (scopeRaw !== undefined) {
    if (scopeRaw === "inbox" || scopeRaw === "followed") {
      scopeVal = scopeRaw;
    } else {
      output.error("--scope must be inbox or followed.");
      return 1;
    }
  }
  if (threadId && space) {
    output.error("Cannot combine a Thread ID with --space.");
    return 1;
  }
  if (threadId && scopeVal) {
    output.error("Cannot combine a Thread ID with --scope.");
    return 1;
  }
  if (space && scopeVal) {
    output.error("Cannot combine --space with --scope.");
    return 1;
  }

  let limit: number | undefined;
  if (flags.limit !== undefined) {
    const limitStr = flagString(flags, "limit")?.trim();
    if (!limitStr || !/^\d+$/.test(limitStr)) {
      output.error("--limit must be an integer between 1 and 1000.");
      return 1;
    }
    limit = Number(limitStr);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      output.error("--limit must be an integer between 1 and 1000.");
      return 1;
    }
  }

  const sinceVal = flagString(flags, "since")?.trim();
  let afterForServer: string | undefined;
  let sinceDate: number | undefined;
  if (flags.since !== undefined) {
    if (!sinceVal) {
      output.error("--since needs a position, post id (n_…), or ISO date.");
      return 1;
    }
    if (/^\d+$/.test(sinceVal)) {
      const pos = Number(sinceVal);
      if (!Number.isSafeInteger(pos) || pos < 0) {
        output.error("--since position must be a non-negative safe integer.");
        return 1;
      }
      afterForServer = sinceVal;
    } else if (NODE_ID.test(sinceVal)) {
      afterForServer = sinceVal;
    } else if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(sinceVal)) {
      const parsed = Date.parse(sinceVal);
      if (Number.isNaN(parsed)) {
        output.error("--since must be a valid ISO date.");
        return 1;
      }
      sinceDate = parsed;
    } else {
      output.error("--since needs a position, post id (n_…), or ISO date.");
      return 1;
    }
  }

  const depthVal = flagString(flags, "depth") ?? "summary";
  if (depthVal !== "name" && depthVal !== "summary") {
    output.error("--depth must be name or summary for post listings.");
    return 1;
  }

  const orderRaw = flagString(flags, "order") ?? "newer";
  let orderVal: "newer" | "older";
  if (orderRaw === "newer" || orderRaw === "older") {
    orderVal = orderRaw;
  } else {
    output.error("--order must be newer or older.");
    return 1;
  }

  const cursor = flagString(flags, "cursor")?.trim();

  return runAuthenticated(output, async (config) => {
    const query: ThreadPostsQuery = {
      order: orderVal,
    };
    if (threadId) {
      query.thread_id = threadId;
    } else if (space) {
      query.space_id = space;
    } else if (scopeVal) {
      query.scope = scopeVal;
    } else {
      query.scope = "inbox";
    }

    if (limit !== undefined) query.limit = limit;
    if (afterForServer) query.after = afterForServer;
    if (cursor) query.cursor = cursor;

    const response = await fetchThreadPosts(config, query);
    let items = response.items;
    let filteredByDate = false;
    if (sinceDate !== undefined) {
      const originalCount = items.length;
      items = items.filter((item) => Date.parse(item.created_at) > sinceDate!);
      if (items.length < originalCount) {
        filteredByDate = true;
      }
    }

    let text: string;
    if (!items.length) {
      if (filteredByDate && response.next_cursor) {
        text = `No hosted posts newer than ${sinceVal} on this page. More posts: ideaspaces threads posts --cursor ${response.next_cursor}`;
      } else {
        text = "No hosted posts found.";
      }
    } else {
      const postLines = items
        .map((post) => {
          const actor = post.actor_ref === post.author_ref ? "" : ` via ${post.actor_ref}`;
          const header = `${post.thread_name}  (${post.exchange_id})\n  [${post.position}] ${post.note_node_id} · ${post.created_at} · ${post.author_ref}${actor} — ${post.name}`;
          if (depthVal === "name") {
            return header;
          }
          return `${header}\n  ${post.summary}`;
        })
        .join("\n\n");

      if (response.next_cursor) {
        text = `${postLines}\n\nMore posts: ideaspaces threads posts --cursor ${response.next_cursor}`;
      } else {
        text = postLines;
      }
    }

    output.result({ items, next_cursor: response.next_cursor }, text);
    return 0;
  });
}

export const hostedThreadsCommand: CommandDef = {
  name: "threads-hosted",
  description: "Send, read, and manage hosted Threads (management is owner-only)",
  usage: USAGE,
  examples: [
    "ideaspaces threads list --new --depth name",
    "ideaspaces threads list --space n_0123456789abcdef01234567",
    "ideaspaces threads posts --limit 10",
    "ideaspaces threads posts --space n_0123456789abcdef01234567",
    "ideaspaces threads posts x_0123456789abcdef01234567 --limit 5",
    "ideaspaces threads posts --cursor eyJwIjo2NywibyI6ImRlc2MifQ==",
    "ideaspaces threads read x_example --new --depth full --ack  # JSON includes your_grade",
    "ideaspaces threads list --kind message --json  # each hosted row includes your_grade",
    "ideaspaces threads expand x_example 0",
    "ideaspaces threads send @owner --space n_0123456789abcdef01234567 --about n_0123456789abcdef01234567 --grade view --name 'Question' --summary 'One decision' --message 'What should happen next?'",
    "ideaspaces threads add x_example @colleague --grade participate  # preview; add --yes to grant as owner",
    "ideaspaces threads close x_example  # preview; add --yes to close as owner",
    "ideaspaces threads rename x_example --name 'New title'  # applies immediately; owner only",
    "ideaspaces threads reply x_example --reply-to n_0123456789abcdef01234567 --name 'Answer' --summary 'Summary' --message 'Here is the response'",
    "ideaspaces threads send @owner --map selection.json --name 'Question' --summary 'One decision' --message 'What should happen next?'",
    "ideaspaces threads send @owner --about n_0123456789abcdef01234567 --name 'Question' --summary 'One decision' --message 'What should happen next?'",
    "ideaspaces threads send @owner --map selection.json --share viewer --name 'Question' --summary 'One decision' --message 'What should happen next?'",
    "ideaspaces threads send --about n_0123456789abcdef01234567 --name 'Bug' --summary 'share invite 404s' --message '…'  # no recipient: goes to the Node's owner",
    "ideaspaces threads reply x_example --map selection.json --name 'Answer' --summary 'A bounded answer' --message 'Here is the counter-proposal'",
    "printf '# Reply\\n\\nKeep it narrow.' | ideaspaces threads reply x_example --name 'Answer' --summary 'A bounded answer'",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    const flagError = threadFlagError(sub ?? "", flags);
    if (flagError) {
      output.error(flagError);
      return 1;
    }
    switch (sub) {
      case "list":
        return list(rest, flags, output);
      case "posts":
        return posts(rest, flags, output);
      case "read":
        return read(rest, flags, output);
      case "send":
        return send(rest, flags, output);
      case "reply":
        return reply(rest, flags, output);
      case "add":
      case "close":
      case "rename":
        return manage(sub, rest, flags, output, global.yes === true);
      case "expand":
        return expand(rest, output);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};

/** One-release compatibility name. Never silently reuse inbox for a new Thread feature. */
export const inboxCommand: CommandDef = {
  ...hostedThreadsCommand,
  name: "inbox",
  description: "Legacy name for hosted threads (deprecated; use threads)",
  usage: USAGE.replace("ideaspaces threads", "ideaspaces inbox"),
  examples: hostedThreadsCommand.examples?.map((example) => example.replace("ideaspaces threads", "ideaspaces inbox")),
  async run(args, flags, global) {
    createOutput(global).log("`ideaspaces inbox` is deprecated; use `ideaspaces threads` (legacy alias for this release).");
    return hostedThreadsCommand.run(args, flags, global);
  },
};
