import { randomUUID } from "node:crypto";

import {
  fetchExchange,
  fetchInbox,
  replyToExchange,
  sendInquiry,
  UnauthorizedError,
  type ExchangeNoteWrite,
  type ExchangeReadResponse,
  type InboxItem,
  type InboxParticipant,
  type InquirySendBody,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const USAGE = "ideaspaces inbox <list|read|send|reply> ...";
const SEND_USAGE =
  "ideaspaces inbox send <email|@handle> --about <node_id> --name <title> --summary <summary> [--message <markdown>] [--send-id <id>]";
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

function participantLabel(participant: InboxParticipant): string {
  return participant.name ?? participant.username ?? participant.participant;
}

function participantsText(participants: InboxParticipant[]): string {
  return participants.map(participantLabel).join(", ");
}

function inboxItemText(item: InboxItem): string {
  const count = `${item.message_count} ${item.message_count === 1 ? "message" : "messages"}`;
  return [
    `${item.exchange_id}  ${item.latest_message.name}`,
    `  ${item.latest_message.summary}`,
    `  about ${item.target_node_id} · ${count} · ${participantsText(item.participants)}`,
  ].join("\n");
}

function exchangeText(exchange: ExchangeReadResponse): string {
  const lines = [
    `Thread ${exchange.exchange_id}`,
    `About ${exchange.target_node_id}`,
    `Participants: ${participantsText(exchange.participants)}`,
  ];
  for (const message of exchange.messages) {
    const author = exchange.participants.find(
      (participant) => participant.participant === message.author_ref,
    );
    const actor = message.actor_ref === message.author_ref ? "" : ` via ${message.actor_ref}`;
    lines.push(
      "",
      `[${message.position}] ${author ? participantLabel(author) : message.author_ref}${actor} — ${message.name}`,
      message.summary,
      message.markdown,
    );
  }
  return lines.join("\n");
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

async function list(rest: string[], output: Output): Promise<number> {
  if (rest.length) {
    output.error("Usage: ideaspaces inbox list");
    return 1;
  }
  return runAuthenticated(output, async (config) => {
    const inbox = await fetchInbox(config);
    output.result(
      inbox,
      inbox.items.length ? inbox.items.map(inboxItemText).join("\n\n") : "Inbox is empty.",
    );
    return 0;
  });
}

async function read(rest: string[], output: Output): Promise<number> {
  const [exchangeId] = rest;
  if (!exchangeId || rest.length !== 1) {
    output.error("Usage: ideaspaces inbox read <thread_id>");
    return 1;
  }
  return runAuthenticated(output, async (config) => {
    const exchange = await fetchExchange(config, exchangeId);
    output.result(exchange, exchangeText(exchange));
    return 0;
  });
}

async function send(rest: string[], flags: Flags, output: Output): Promise<number> {
  const [recipientValue] = rest;
  const recipient = recipientValue ? recipientSelector(recipientValue) : null;
  const target = flagString(flags, "about")?.trim();
  if (!recipientValue || rest.length !== 1 || !recipient || !target) {
    output.error(`Usage: ${SEND_USAGE}`);
    return 1;
  }
  const note = await writeBody(flags, output);
  if (!note) return 1;
  return runAuthenticated(output, async (config) => {
    const result = await sendInquiry(config, {
      ...note,
      target_node_id: target,
      recipient,
    });
    output.result(result, `Sent. Thread ${result.exchange_id} is about ${result.target_node_id}.`);
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
    output.result(result, `Replied in ${result.exchange_id}.`);
    return 0;
  });
}

export const inboxCommand: CommandDef = {
  name: "inbox",
  description: "Ask, read, and reply to messages about shared Content",
  usage: USAGE,
  examples: [
    "ideaspaces inbox list",
    "ideaspaces inbox read x_example",
    "ideaspaces inbox send @owner --about n_0123456789abcdef01234567 --name 'Question' --summary 'One decision' --message 'What should happen next?'",
    "printf '# Reply\\n\\nKeep it narrow.' | ideaspaces inbox reply x_example --name 'Answer' --summary 'A bounded answer'",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    switch (sub) {
      case "list":
        return list(rest, output);
      case "read":
        return read(rest, output);
      case "send":
        return send(rest, flags, output);
      case "reply":
        return reply(rest, flags, output);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};
