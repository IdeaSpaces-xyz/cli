/**
 * Claude Code conversation lifecycle — read the sessions Claude Code keeps on
 * disk and present them in the same shapes the remote conversation API uses,
 * so a client treats a Claude-backed local conversation exactly like a pi or
 * remote one.
 *
 * A conversation is a Claude Code session file at
 * `<config>/projects/<slug>/<session-id>.jsonl`, where `<config>` is
 * `$CLAUDE_CONFIG_DIR` or `~/.claude` and `<slug>` is the POV root with every
 * non-alphanumeric character replaced by `-`. The conversation id IS the
 * session id (a UUID). We parse the file directly — `get`/`list` are read-only
 * and frequent — and never touch anything else under the config dir (no
 * credentials, no settings). `new` mints an id; the first `send --local` creates
 * the session with `--session-id`.
 *
 * Session entry shapes (Claude Code 2.1, read from a recorded run):
 *   {type:"user", message:{role:"user", content:"<prompt>" | [{type:"tool_result",…}]}, timestamp, isSidechain, isMeta?}
 *   {type:"assistant", message:{id, model, role:"assistant", content:[<one block>], usage}, timestamp}
 *     — one record per content block; records sharing `message.id` are one API message
 *   {type:"ai-title", aiTitle}                — display name, once Claude Code has titled it
 *   {type:"summary", summary}                 — older sessions: the compaction title
 *   attachment / system / last-prompt / queue-operation / atis-latch — bookkeeping, skipped
 * Sidechain records (`isSidechain: true`) are subagent traffic and are skipped;
 * subagent transcripts live in their own files under the session's subdirectory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ConversationDetail,
  ConversationHistoryMessage,
  ConversationSummary,
  ConversationsResponse,
} from "../auth/api.js";

/** Claude Code's config dir — `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/** The project slug Claude Code derives from a cwd: every non-alphanumeric → `-`. */
export function claudeProjectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9]/gu, "-");
}

/** Where Claude Code keeps the sessions started in `cwd`. */
export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "projects", claudeProjectSlug(cwd));
}

/** Mint a fresh conversation id — Claude Code requires a UUID for `--session-id`. */
export function mintClaudeConversationId(): string {
  return randomUUID();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const COMMAND = /^\s*<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-message>[\s\S]*?<\/command-message>)?\s*(?:<command-args>([\s\S]*?)<\/command-args>)?\s*$/u;
const COMMAND_OUTPUT = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/u;

export function isClaudeConversationId(id: string): boolean {
  return UUID.test(id);
}

/** The session file for a conversation, or null if Claude Code has none for it.
 * Guards the id so a caller can never read outside the project dir. */
export function claudeSessionFile(cwd: string, convId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isClaudeConversationId(convId)) return null;
  const file = join(claudeProjectDir(cwd, env), `${convId}.jsonl`);
  return existsSync(file) ? file : null;
}

interface ParsedSession {
  id: string;
  name: string | null;
  messages: ConversationHistoryMessage[];
  /** Visible turns (user prompts + assistant messages), matching remote message_count intent. */
  messageCount: number;
  preview: string;
  updatedAt: string;
  modelTier: string | null;
}

/** Join the `text` parts of a content array (drops thinking/tool_use parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("");
}

/** Parse one Claude Code session JSONL into the neutral conversation shape. */
export function parseClaudeSessionJsonl(text: string, fallbackTs: string): ParsedSession {
  let id = "";
  let name: string | null = null;
  const messages: ConversationHistoryMessage[] = [];
  let preview = "";
  let count = 0;
  let lastTs = fallbackTs;
  let modelTier: string | null = null;
  // Tool names for results, which only carry the call id.
  const toolNames = new Map<string, string>();
  // Assistant records sharing one `message.id` fold into one history entry.
  // Claude Code runs tools as their blocks arrive, so a tool_result record can
  // sit between two blocks of the same API message — the fold keys on the id,
  // not on adjacency.
  let openAssistant: { messageId: string; entry: ConversationHistoryMessage } | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof e.sessionId === "string" && !id) id = e.sessionId;
    if (e.type === "ai-title") {
      if (typeof e.aiTitle === "string" && e.aiTitle.trim()) name = e.aiTitle;
      continue;
    }
    if (e.type === "summary") {
      if (!name && typeof e.summary === "string" && e.summary.trim()) name = e.summary;
      continue;
    }
    if ((e.type !== "user" && e.type !== "assistant") || e.isSidechain === true || e.isMeta === true) continue;
    if (!e.message || typeof e.message !== "object") continue;
    const m = e.message as Record<string, unknown>;
    const created = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (created) lastTs = created;

    if (e.type === "user") {
      if (typeof m.content === "string" || (Array.isArray(m.content) && m.content.every((c) => (c as { type?: string })?.type === "text"))) {
        openAssistant = null; // a new prompt; the next assistant record starts a new message
        const content = textOf(m.content);
        const cmdMatch = COMMAND.exec(content);
        const outMatch = COMMAND_OUTPUT.exec(content);
        if (cmdMatch) {
          const cmdName = cmdMatch[1]?.trim() ?? "";
          const cmdArgs = cmdMatch[2]?.trim() ?? "";
          messages.push({
            role: "user",
            content,
            kind: "command",
            command: cmdName,
            ...(cmdArgs ? { args: cmdArgs } : {}),
            created_at: created,
          });
          count += 1;
          continue;
        }
        if (outMatch) {
          messages.push({
            role: "user",
            content,
            kind: "command-output",
            created_at: created,
          });
          count += 1;
          continue;
        }
        messages.push({ role: "user", content, created_at: created });
        if (!preview) preview = content.replace(/\s+/g, " ").trim().slice(0, 120);
        count += 1;
        continue;
      }
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as Record<string, unknown>[]) {
        if (block.type !== "tool_result") continue;
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        messages.push({
          role: "tool",
          content: textOf(block.content),
          tool_call_id: callId,
          tool_name: callId ? toolNames.get(callId) : undefined,
          is_error: block.is_error === true,
          created_at: created,
        });
      }
      continue;
    }

    // assistant — one block per record; fold by API message id.
    const messageId = typeof m.id === "string" ? m.id : "";
    if (typeof m.model === "string" && m.model) modelTier = m.model;
    if (!openAssistant || openAssistant.messageId !== messageId) {
      openAssistant = { messageId, entry: { role: "assistant", content: "", created_at: created } };
      messages.push(openAssistant.entry);
      count += 1;
    }
    const entry = openAssistant.entry;
    entry.content += textOf(m.content);
    if (m.usage && typeof m.usage === "object") entry.usage = m.usage as Record<string, unknown>;
    for (const block of Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []) {
      if (block.type !== "tool_use") continue;
      const call = {
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        args: (block.input as Record<string, unknown>) ?? {},
      };
      toolNames.set(call.id, call.name);
      (entry.tool_calls ??= []).push(call);
    }
  }

  return { id, name, messages, messageCount: count, preview, updatedAt: lastTs, modelTier };
}

/** A Claude-backed conversation's detail, in the remote `ConversationDetail` shape. */
export function getClaudeConversation(contextRoot: string, convId: string, env: NodeJS.ProcessEnv = process.env): ConversationDetail {
  const file = claudeSessionFile(contextRoot, convId, env);
  if (!file) {
    // Minted but not yet sent to — an empty conversation.
    return { conversation_id: convId, repo_id: contextRoot, name: "", history: [], active_turn: null };
  }
  const mtime = statSync(file).mtime.toISOString();
  const s = parseClaudeSessionJsonl(readFileSync(file, "utf8"), mtime);
  return {
    conversation_id: convId,
    repo_id: contextRoot,
    name: s.name ?? s.preview ?? "Untitled",
    history: s.messages,
    active_turn: null,
    turn_count: s.messageCount,
    updated_at: s.updatedAt,
    ...(s.modelTier ? { model_tier: s.modelTier } : {}),
  };
}

/** List the Claude Code sessions started in this context, newest-first. */
export function listClaudeConversations(contextRoot: string, env: NodeJS.ProcessEnv = process.env): ConversationsResponse {
  const dir = claudeProjectDir(contextRoot, env);
  if (!existsSync(dir)) return { conversations: [], total: 0 };
  const summaries: ConversationSummary[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl") && isClaudeConversationId(f.slice(0, -6)))) {
    const path = join(dir, f);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const mtime = statSync(path).mtime.toISOString();
    const s = parseClaudeSessionJsonl(text, mtime);
    const conversationId = s.id || f.slice(0, -6);
    if (!s.messageCount) continue; // a session file with no visible turn is not a conversation yet
    summaries.push({
      conversation_id: conversationId,
      name: s.name ?? s.preview ?? "Untitled",
      summary: s.preview,
      message_count: s.messageCount,
      status: "idle",
      updated_at: s.updatedAt,
    });
  }
  summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { conversations: summaries, total: summaries.length };
}
