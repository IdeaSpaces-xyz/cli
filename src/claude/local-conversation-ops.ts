// The LOCAL (Claude Code) side of the `conversation` / `conversations`
// commands — the `--local --runtime=claude` handlers. Same seam as the pi ops
// (`src/pi/local-conversation-ops.ts`); the router picks one by `--runtime`.

import type { Output } from "../output.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import { loadMapNoteOrientation } from "../local/map-note.js";
import { localLaunchOrientation } from "../local/launch-orientation.js";
import {
  CLAUDE_AUTH_MODES,
  CLAUDE_PERMISSION_MODES,
  isValidClaudeAuthMode,
  isValidClaudePermissionMode,
  runClaudeTurn,
} from "./local-agent.js";
import {
  getClaudeConversation,
  isClaudeConversationId,
  listClaudeConversations,
  mintClaudeConversationId,
} from "./local-conversations.js";

type Flags = Record<string, string | boolean>;

function reportLocalError(err: unknown, output: Output): number {
  output.error(err instanceof Error ? err.message : String(err));
  return 1;
}

// `send --local --runtime=claude` runs a turn on the user's own Claude Code,
// context-rooted at --context, resuming (or creating) the conversation's Claude
// session. Emits the same Keeper JSON-lines contract as the pi and remote sends.
async function send(flags: Flags, output: Output): Promise<number> {
  const message = typeof flags.message === "string" ? flags.message : undefined;
  if (!message) {
    output.error("A message is required: --message <text>");
    return 1;
  }
  const repoPath = typeof flags.context === "string" ? flags.context : process.cwd();
  // Claude Code requires a UUID session id; a fresh one is minted when absent,
  // which is the `new` step folded into the first send.
  const conversationId = typeof flags.conversation === "string" ? flags.conversation : mintClaudeConversationId();
  if (!isClaudeConversationId(conversationId)) {
    output.error(`A Claude Code conversation id is a UUID; got "${conversationId}"`);
    return 1;
  }
  const modelTier = typeof flags["model-tier"] === "string" ? flags["model-tier"] : undefined;
  const model = typeof flags["claude-model"] === "string" ? flags["claude-model"] : undefined;
  const permissionMode = typeof flags["permission-mode"] === "string" ? flags["permission-mode"] : "acceptEdits";
  if (!isValidClaudePermissionMode(permissionMode)) {
    output.error(`Invalid permission mode "${permissionMode}". Valid values: ${CLAUDE_PERMISSION_MODES.join(", ")}`);
    return 1;
  }
  const auth = typeof flags["claude-auth"] === "string" ? flags["claude-auth"] : "login";
  if (!isValidClaudeAuthMode(auth)) {
    output.error(`Invalid auth mode "${auth}". Valid values: ${CLAUDE_AUTH_MODES.join(", ")}`);
    return 1;
  }
  // The claude binary to spawn — the desktop passes the path from its settings.
  // Absent → PATH `claude` (dev). Never bundled: it is the user's own install.
  const claudeBin = typeof flags["claude-bin"] === "string" ? flags["claude-bin"] : undefined;

  if (flags.map === true || (typeof flags.map === "string" && !flags.map.trim())) {
    output.error("A map-note path is required: --map <file.md>");
    return 1;
  }
  let mapOrientation: string | undefined;
  if (typeof flags.map === "string") {
    try {
      mapOrientation = loadMapNoteOrientation(flags.map, repoPath);
    } catch (err) {
      return reportLocalError(err, output);
    }
  }

  let launchOrientation: string | undefined;
  let workingRoot: string | undefined;
  if (flags["working-root"] !== undefined || flags.focus !== undefined) {
    if (typeof flags["working-root"] !== "string" ||
        (flags.focus !== undefined && typeof flags.focus !== "string")) {
      output.error("Use --working-root <absolute-directory> with optional --focus <relative-path>");
      return 1;
    }
    try {
      workingRoot = flags["working-root"];
      launchOrientation = localLaunchOrientation(repoPath, workingRoot, flags.focus as string | undefined);
    } catch (err) {
      return reportLocalError(err, output);
    }
  }

  const controller = new AbortController();
  let signalled = false;
  const onSignal = (): void => {
    if (signalled) return;
    signalled = true;
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    for await (const event of runClaudeTurn({
      repoPath,
      workingRoot,
      message,
      conversationId,
      modelTier,
      mapOrientation,
      launchOrientation,
      model,
      permissionMode,
      auth,
      claudeBin,
      signal: controller.signal,
    })) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    return 0;
  } catch (err) {
    return reportLocalError(err, output);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// `new --local --runtime=claude` mints a Claude session id. The session is
// created on the first `send` (`--session-id` creates it); Claude Code titles
// it itself after the first exchange.
function createNew(_flags: Flags, output: Output): number {
  const id = mintClaudeConversationId();
  output.result({ conversation_id: id }, `Created local conversation ${id}`);
  return 0;
}

// `get --local --runtime=claude --conversation <id>` reads the Claude session
// for this context and returns the same ConversationDetail shape as remote get.
function get(flags: Flags, output: Output): number {
  const convId = typeof flags.conversation === "string" ? flags.conversation : undefined;
  if (!convId) {
    output.error("A conversation id is required: --conversation <id>");
    return 1;
  }
  const contextRoot = typeof flags.context === "string" ? flags.context : process.cwd();
  const detail = getClaudeConversation(contextRoot, convId);
  output.result(
    detail,
    detail.history.length
      ? detail.history
          .map((m) => {
            const preview = m.content.replace(/\s+/g, " ");
            return `${m.role}: ${preview.length > 80 ? `${preview.slice(0, 79)}…` : preview}`;
          })
          .join("\n")
      : "No messages yet.",
  );
  return 0;
}

// `conversations --local --runtime=claude` lists the Claude sessions started in
// this context.
function list(flags: Flags, output: Output): number {
  const contextRoot = typeof flags.context === "string" ? flags.context : process.cwd();
  const { conversations, total } = listClaudeConversations(contextRoot);
  output.result(
    { context: contextRoot, conversations, total, has_more: false },
    conversations.length
      ? conversations
          .map((c) => `${c.name || "(untitled)"} — ${c.message_count} message${c.message_count === 1 ? "" : "s"}`)
          .join("\n")
      : "No local conversations.",
  );
  return 0;
}

/** The Claude Code implementation of the local-conversation seam. */
export const claudeConversationOps: LocalConversationOps = { send, createNew, get, list };
