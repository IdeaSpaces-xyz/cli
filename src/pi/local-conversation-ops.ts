// The LOCAL (Pi) side of the `conversation` / `conversations` commands — the
// `--local` handlers. Kept here (not in src/commands/) so the core commands stay
// Pi-free: they dispatch `--local` to this injected `LocalConversationOps`, and
// only the composition root (router) wires the two together. See src/pi/index.ts
// for the boundary rule.

import { join } from "node:path";
import type { Output } from "../output.js";
import type { LocalConversationOps } from "../commands/conversation.js";
import { runLocalTurn } from "./local-agent.js";
import { getLocalConversation, listLocalConversations, mintConversationId } from "./local-conversations.js";

type Flags = Record<string, string | boolean>;

/** A flag's comma-separated value with an env fallback → split, trim, drop
 * empties. Used by the local turn's `--ext` and `--skill` resource-dir lists. */
function parseCommaList(flag: string | boolean | undefined, envFallback: string | undefined): string[] {
  const raw = typeof flag === "string" ? flag : envFallback;
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Local turns don't hit the remote auth path, so a plain message + exit-1 is the
 * whole error contract (no UnauthorizedError to special-case). */
function reportLocalError(err: unknown, output: Output): number {
  output.error(err instanceof Error ? err.message : String(err));
  return 1;
}

// `send --local <conv>` runs a turn on a LOCAL pi runtime (not the remote
// Keeper), context-rooted at cwd (a workspace that may mount repos), resuming
// the conversation's pi session. Emits the same Keeper JSON-lines contract as
// remote `send`, so any client renders it identically.
async function send(flags: Flags, output: Output): Promise<number> {
  const message = typeof flags.message === "string" ? flags.message : undefined;
  if (!message) {
    output.error("A message is required: --message <text>");
    return 1;
  }
  // Both extensions: pi-is-space (Space) + pi-local-context (conversation). Until
  // distribution bundles them, the caller supplies the paths.
  const extensionPaths = parseCommaList(flags.ext, process.env.IDEASPACES_PI_EXTENSIONS);
  if (!extensionPaths.length) {
    output.error(
      "Extensions are required: --ext <pi-is-space,pi-local-context> (or set IDEASPACES_PI_EXTENSIONS)",
    );
    return 1;
  }
  // Skill dirs — optional. `--extension` loads extension code but not the
  // package's skills, so a shipped app forwards them here. Empty in dev when the
  // user has `pi install`ed the extensions (skills already in `~/.pi/settings`).
  const skillPaths = parseCommaList(flags.skill, process.env.IDEASPACES_PI_SKILLS);

  const repoPath = typeof flags.context === "string" ? flags.context : process.cwd();
  const sessionDir =
    typeof flags["session-dir"] === "string" ? flags["session-dir"] : join(repoPath, ".pi", "sessions");
  // Id via --conversation (a flag), not a bare positional: the arg parser has no
  // command-scoped booleans, so `--local <id>` would swallow the id.
  const conversationId =
    typeof flags.conversation === "string" ? flags.conversation : `local-${Date.now().toString(36)}`;
  const modelTier = typeof flags["model-tier"] === "string" ? flags["model-tier"] : "local";
  const piModel = typeof flags["pi-model"] === "string" ? flags["pi-model"] : undefined;
  // The pi binary to spawn — the desktop passes its bundled sidecar here. Absent
  // → runLocalTurn falls back to PATH `pi` (dev). Without this the bundled pi is
  // never used, silently falling back to a globally-installed pi.
  const piBin = typeof flags["pi-bin"] === "string" ? flags["pi-bin"] : undefined;

  // Abort propagation: SIGINT/SIGTERM (or the desktop killing the sidecar) kills
  // the local pi turn. Guarded so repeats don't double-fire.
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
    for await (const event of runLocalTurn({
      repoPath,
      message,
      extensionPaths,
      skillPaths,
      conversationId,
      sessionDir,
      modelTier,
      piModel,
      piBin,
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

// `new --local` mints a local conversation id (= pi session id). The session
// is created lazily on the first `send --local` (pi's --session-id creates it),
// then named from the first message. Context-rooted; no repo, no server.
function createNew(output: Output): number {
  const id = mintConversationId();
  output.result({ conversation_id: id }, `Created local conversation ${id}`);
  return 0;
}

// `get --local --conversation <id>` reads the context's pi session JSONL and
// returns the same ConversationDetail shape as the remote get. Id via
// --conversation (a bare positional after --local is swallowed by the parser).
function get(flags: Flags, output: Output): number {
  const convId = typeof flags.conversation === "string" ? flags.conversation : undefined;
  if (!convId) {
    output.error("A conversation id is required: --conversation <id>");
    return 1;
  }
  const contextRoot = typeof flags.context === "string" ? flags.context : process.cwd();
  const detail = getLocalConversation(contextRoot, convId);
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

// `conversations --local` lists the current context's pi sessions — no repo,
// no server.
function list(flags: Flags, output: Output): number {
  const contextRoot = typeof flags.context === "string" ? flags.context : process.cwd();
  const { conversations, total } = listLocalConversations(contextRoot);
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

/** The Pi implementation of the local-conversation seam, injected into the core
 * `conversation`/`conversations` commands by the router. */
export const localConversationOps: LocalConversationOps = { send, createNew, get, list };
