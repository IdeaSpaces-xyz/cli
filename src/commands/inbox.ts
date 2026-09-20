import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import {
  acknowledgeSubscription,
  fetchExchange,
  fetchExchangeMapMember,
  fetchInbox,
  fetchSubscriptionEvents,
  listSubscriptions,
  replyToExchange,
  sendInquiry,
  UnauthorizedError,
  type ExchangeMapMemberResponse,
  type ExchangeMessage,
  type ExchangeNoteWrite,
  type ExchangeReadResponse,
  type FollowEvent,
  type InboxItem,
  type InboxParticipant,
  type InquiryInboxItem,
  type InquirySendBody,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import {
  formatPortableMap,
  memberReference,
  parseExchangeMapSelection,
  type ExchangeMapSelection,
} from "../exchange-map-selection.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const USAGE = "ideaspaces inbox <list|read|send|reply|expand> ...";
const LIST_USAGE =
  "ideaspaces inbox list [--new|--since <position>] [--kind <message|reframe|request>] [--depth <name|summary|full>]";
const READ_USAGE =
  "ideaspaces inbox read <thread_id> [--new|--since <position>] [--kind <message|reframe>] [--depth <name|summary|full>] [--ack]";
const SEND_USAGE =
  "ideaspaces inbox send [<email|@handle>] [--about <node_id>] [--map <selection.json>] --name <title> --summary <summary> [--message <markdown>] [--send-id <id>]";
const EXPAND_USAGE = "ideaspaces inbox expand <thread_id> <member_ordinal>";
const MAX_SELECTION_FILE_BYTES = 128 * 1024;
const REPLY_USAGE =
  "ideaspaces inbox reply <thread_id> --name <title> --summary <summary> [--message <markdown>] [--send-id <id>]";

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
  if (!path) return undefined;
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

type InboxKind = "message" | "reframe" | "request";
type ReadDepth = "name" | "summary" | "full";

function isInquiry(item: InboxItem): item is InquiryInboxItem {
  return item.kind === "inquiry";
}

function inboxItemName(item: InboxItem): string {
  if (isInquiry(item)) return `${item.exchange_id}  ${item.latest_message.name}`;
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
    `  about ${item.target_node_id} · ${count} · ${cursor} · ${participantsText(item.participants)}`,
  ].join("\n");
}

function exchangeText(
  exchange: ExchangeReadResponse,
  messages: ExchangeMessage[] = exchange.messages,
  depth: ReadDepth = "full",
): string {
  const current = exchange.messages.find(
    (message) => message.note_node_id === exchange.subject?.current_note_id,
  ) ?? exchange.messages.at(-1);
  if (depth === "name") return `${exchange.exchange_id}  ${current?.name ?? "Thread"}`;

  const lines = [
    `Thread ${exchange.exchange_id}`,
    `About ${exchange.target_node_id}`,
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
      `[${message.position}] ${author ? participantLabel(author) : message.author_ref}${actor} — ${message.name}`,
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
  if (value === "message" || value === "reframe" || value === "request") return value;
  output.error("--kind must be one of: message, reframe, request.");
  return null;
}

function parseDepth(value: string | boolean | undefined, output: Output): ReadDepth | null {
  if (value === undefined) return "summary";
  if (value === "name" || value === "summary" || value === "full") return value;
  output.error("--depth must be one of: name, summary, full.");
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
    output.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

async function list(rest: string[], flags: Flags, output: Output): Promise<number> {
  if (rest.length) {
    output.error(`Usage: ${LIST_USAGE}`);
    return 1;
  }
  if (!validateTemporalFlags(flags, output)) return 1;
  const since = parsePosition(flags.since, output);
  if (since === null) return 1;
  const kind = parseKind(flags.kind, output);
  if (kind === null) return 1;
  const depth = parseDepth(flags.depth, output);
  if (!depth) return 1;

  return runAuthenticated(output, async (config) => {
    const inbox = await fetchInbox(config);
    let items = inbox.items.filter((item) => since === undefined || item.latest_position > since);
    if (flags.new) {
      items = items.filter((item) => isInquiry(item) && item.cursor !== null && item.latest_position > item.cursor);
    }
    if (kind === "message") items = items.filter(isInquiry);
    if (kind === "request") items = items.filter((item) => !isInquiry(item));
    if (kind === "reframe") {
      const reframed = new Set(
        (await boundedSubscriptionEvents(config))
          .filter((event) => event.action === "thread.reframed")
          .map((event) => event.exchange_id)
          .filter((id): id is string => Boolean(id)),
      );
      items = items.filter((item) => isInquiry(item) && reframed.has(item.exchange_id));
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
        return exchangeText(exchange, exchange.messages, "full");
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
  if (flags.ack && flags.since !== undefined) {
    output.error("--ack cannot be combined with --since because omitted events would be marked read. Use --new --ack, or acknowledge an exact position with `follow --ack`.");
    return 1;
  }
  const since = parsePosition(flags.since, output);
  if (since === null) return 1;
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

  return runAuthenticated(output, async (config) => {
    const exchange = await fetchExchange(config, exchangeId);
    if ((flags.new || flags.ack) && exchange.cursor === null) {
      output.error(`Thread ${exchangeId} is not followed. Run \`ideaspaces follow thread ${exchangeId}\` first.`);
      return 1;
    }
    const after = flags.new ? exchange.cursor ?? undefined : since;
    let messages = exchange.messages.filter(
      (message) => after === undefined || message.position > after,
    );
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

    const data = {
      ...exchange,
      messages,
      ...(kind === "reframe" ? { events } : {}),
      ...(acknowledged ? { acknowledged_cursor: acknowledged.cursor } : {}),
    };
    const empty = kind === "reframe" ? "No new reframe events." : "No messages after that position.";
    output.result(data, messages.length ? exchangeText(exchange, messages, depth) : empty);
    return 0;
  });
}

async function send(rest: string[], flags: Flags, output: Output): Promise<number> {
  // The recipient is optional: a Thread is about a Node, and when no person is
  // named the server addresses that Node's owner. A reporter rarely knows the
  // maker's handle, and nothing the CLI can read exposes an owner.
  const [recipientValue] = rest;
  const recipient = recipientValue ? recipientSelector(recipientValue) : undefined;
  const selection = loadMapSelection(flags, output);
  if (selection === null) return 1;
  const requestedTarget = flagString(flags, "about")?.trim();
  if (selection && requestedTarget && requestedTarget !== selection.target_node_id) {
    output.error("--about does not match the reviewed Map selection target_node_id.");
    return 1;
  }
  const target = requestedTarget ?? selection?.target_node_id;
  if (rest.length > 1 || recipient === null || !target) {
    output.error(`Usage: ${SEND_USAGE}`);
    return 1;
  }
  const note = await writeBody(flags, output);
  if (!note) return 1;
  return runAuthenticated(output, async (config) => {
    const result = await sendInquiry(config, {
      ...note,
      target_node_id: target,
      ...(recipient ? { recipient } : {}),
      ...(selection ? { map: selection.map } : {}),
    });
    const addressed = recipient
      ? `Sent. Thread ${result.exchange_id} is about ${result.target_node_id}.`
      : `Sent to the owner of ${result.target_node_id}. Thread ${result.exchange_id}.`;
    output.result(result, addressed);
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
    const [exchange, result] = await Promise.all([
      fetchExchange(config, exchangeId),
      fetchExchangeMapMember(config, exchangeId, memberOrdinal),
    ]);
    const map = exchange.messages.find((message) => message.map)?.map;
    if (!map || !map.members[result.member_ordinal]) {
      throw new Error("Exchange Map reference is unavailable");
    }
    const data = { ...result, map: { roots: map.roots, members: [result.member] } };
    output.result(data, expansionText(result, exchange));
    return 0;
  });
}

async function reply(rest: string[], flags: Flags, output: Output): Promise<number> {
  const [exchangeId] = rest;
  if (!exchangeId || rest.length !== 1) {
    output.error(`Usage: ${REPLY_USAGE}`);
    return 1;
  }
  const note = await writeBody(flags, output);
  if (!note) return 1;
  return runAuthenticated(output, async (config) => {
    const result = await replyToExchange(config, exchangeId, note);
    output.result(result, `Replied in thread ${result.exchange_id}.`);
    return 0;
  });
}

export const inboxCommand: CommandDef = {
  name: "inbox",
  description: "Ask, read, and reply to messages about shared Content",
  usage: USAGE,
  examples: [
    "ideaspaces inbox list --new --depth name",
    "ideaspaces inbox read x_example --new --depth full --ack",
    "ideaspaces inbox expand x_example 0",
    "ideaspaces inbox send @owner --map selection.json --name 'Question' --summary 'One decision' --message 'What should happen next?'",
    "ideaspaces inbox send @owner --about n_0123456789abcdef01234567 --name 'Question' --summary 'One decision' --message 'What should happen next?'",
    "ideaspaces inbox send --about n_0123456789abcdef01234567 --name 'Bug' --summary 'share invite 404s' --message '…'  # no recipient: goes to the Node's owner",
    "printf '# Reply\\n\\nKeep it narrow.' | ideaspaces inbox reply x_example --name 'Answer' --summary 'A bounded answer'",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    switch (sub) {
      case "list":
        return list(rest, flags, output);
      case "read":
        return read(rest, flags, output);
      case "send":
        return send(rest, flags, output);
      case "reply":
        return reply(rest, flags, output);
      case "expand":
        return expand(rest, output);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};
