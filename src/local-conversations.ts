/**
 * Local conversation lifecycle — read pi's on-disk JSONL sessions and present
 * them in the same shapes the remote conversation API uses, so a client (the
 * desktop) treats a local conversation exactly like a remote one.
 *
 * A conversation is a pi session file under the context's gitignored
 * `.pi/sessions/` (`<ts>_<id>.jsonl`); the conversation id IS the session id.
 * We parse the session directly (no pi spawn — `get`/`list` are read-only and
 * frequent). `new` just mints an id; the session is created on the first
 * `send --local` (pi's `--session-id` creates-if-missing), then named.
 *
 * pi session entry shapes (v3):
 *   {type:"session", id, cwd, ...}                          — header
 *   {type:"session_info", name, ...}                        — display name
 *   {type:"message", message:{role:"user", content:[{type:"text",text}]}}
 *   {type:"message", message:{role:"assistant", content:[{type:"toolCall"|"text",...}], usage}}
 *   {type:"message", message:{role:"toolResult", toolCallId, toolName, content, isError}}
 *
 * v1 reads entries in file order (linear). pi's id/parentId/leaf tree (fork)
 * is a later refinement.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  ConversationDetail,
  ConversationHistoryMessage,
  ConversationSummary,
  ConversationsResponse,
} from "./auth/api.js";

/** The context's gitignored session dir — where local conversations live. */
export function localSessionDir(contextRoot: string): string {
  return join(contextRoot, ".pi", "sessions");
}

/** Mint a fresh local conversation id (= the pi session id). */
export function mintConversationId(): string {
  return `local-${randomUUID()}`;
}

interface ParsedSession {
  id: string;
  name: string | null;
  messages: ConversationHistoryMessage[];
  /** Visible turns (user + assistant), matching remote message_count intent. */
  messageCount: number;
  preview: string;
  updatedAt: string;
}

/** Join the `text` parts of a pi content array (drops thinking/toolCall parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("");
}

/** Parse one pi session JSONL into the neutral conversation shape. */
export function parseSessionJsonl(text: string, fallbackTs: string): ParsedSession {
  let id = "";
  let name: string | null = null;
  const messages: ConversationHistoryMessage[] = [];
  let preview = "";
  let count = 0;
  let lastTs = fallbackTs;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (e.type === "session") {
      if (typeof e.id === "string") id = e.id;
    } else if (e.type === "session_info") {
      if (typeof e.name === "string" && e.name.trim()) name = e.name;
    } else if (e.type === "message" && e.message && typeof e.message === "object") {
      const m = e.message as Record<string, unknown>;
      const created = typeof e.timestamp === "string" ? e.timestamp : undefined;
      if (created) lastTs = created;
      const role = m.role;
      if (role === "user") {
        const content = textOf(m.content);
        messages.push({ role: "user", content, created_at: created });
        if (!preview) preview = content.replace(/\s+/g, " ").trim().slice(0, 120);
        count += 1;
      } else if (role === "assistant") {
        const parts = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
        const toolCalls = parts
          .filter((c) => c.type === "toolCall")
          .map((c) => ({
            id: String(c.id ?? ""),
            name: String(c.name ?? ""),
            args: (c.arguments as Record<string, unknown>) ?? {},
          }));
        messages.push({
          role: "assistant",
          content: textOf(m.content),
          created_at: created,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(m.usage ? { usage: m.usage as Record<string, unknown> } : {}),
        });
        count += 1;
      } else if (role === "toolResult") {
        messages.push({
          role: "tool",
          content: textOf(m.content),
          tool_call_id: typeof m.toolCallId === "string" ? m.toolCallId : undefined,
          tool_name: typeof m.toolName === "string" ? m.toolName : undefined,
          is_error: Boolean(m.isError),
          created_at: created,
        });
      }
    }
  }

  return { id, name, messages, messageCount: count, preview, updatedAt: lastTs };
}

/** Locate a session file by conversation id — filename suffix, then header id. */
function findSessionFile(dir: string, convId: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const bySuffix = files.find((f) => f.endsWith(`_${convId}.jsonl`));
  if (bySuffix) return join(dir, bySuffix);
  for (const f of files) {
    try {
      const first = readFileSync(join(dir, f), "utf8").split("\n", 1)[0];
      if ((JSON.parse(first) as { id?: string }).id === convId) return join(dir, f);
    } catch {
      /* skip unreadable */
    }
  }
  return null;
}

/** A local conversation's detail, in the remote `ConversationDetail` shape. */
export function getLocalConversation(contextRoot: string, convId: string): ConversationDetail {
  const file = findSessionFile(localSessionDir(contextRoot), convId);
  if (!file) {
    // Minted but not yet sent to — an empty conversation.
    return { conversation_id: convId, repo_id: contextRoot, name: "", history: [], active_turn: null };
  }
  const mtime = statSync(file).mtime.toISOString();
  const s = parseSessionJsonl(readFileSync(file, "utf8"), mtime);
  return {
    conversation_id: convId,
    repo_id: contextRoot,
    name: s.name ?? s.preview ?? "Untitled",
    history: s.messages,
    active_turn: null,
    turn_count: s.messageCount,
    updated_at: s.updatedAt,
  };
}

/** List the context's local conversations, newest-first. */
export function listLocalConversations(contextRoot: string): ConversationsResponse {
  const dir = localSessionDir(contextRoot);
  if (!existsSync(dir)) return { conversations: [], total: 0 };
  const summaries: ConversationSummary[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(dir, f);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const mtime = statSync(path).mtime.toISOString();
    const s = parseSessionJsonl(text, mtime);
    if (!s.id) continue;
    summaries.push({
      conversation_id: s.id,
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
