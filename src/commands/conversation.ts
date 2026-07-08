import {
  addParticipant,
  cancelConversationTurn,
  createConversation,
  fetchRepoMembers,
  getConversation,
  listParticipants,
  removeParticipant,
  streamConversationMessage,
  UnauthorizedError,
  type ApiConfig,
  type CreateConversationBody,
} from "../auth/api.js";
import { join } from "node:path";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import { runLocalTurn } from "../local-agent.js";
import { getLocalConversation, mintConversationId } from "../local-conversations.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

// `conversations` (plural) lists a repo's conversations; `conversation`
// (singular) operates on one — create a shell and manage its participants.
// Membership is conversation-keyed on the server (no Space needed), so these
// drive the repo-routed `…/conversations/{id}/participants` surface directly.

/** Turn a bare username into a `person:` principal; pass through a string that
 * already carries a known prefix (`person:`/`agent:`/`node:`). The server takes
 * the raw principal and does not resolve, so the client owns this mapping. */
function toPrincipal(actor: string): string {
  return /^(person|agent|node):/.test(actor) ? actor : `person:${actor}`;
}

/** Validate the `--role` flag, defaulting to `member`. Returns null on a bad
 * value so the caller can refuse rather than silently coerce. */
function parseRole(value: string | boolean | undefined): "member" | "reader" | null {
  if (value === undefined || value === "member") return "member";
  if (value === "reader") return "reader";
  return null;
}

function requireConfig(output: Output): ApiConfig | null {
  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return null;
  }
  return config;
}

function reportError(err: unknown, output: Output): number {
  if (err instanceof UnauthorizedError) {
    output.error("Session expired. Run `ideaspaces login`.");
    return 1;
  }
  output.error(err instanceof Error ? err.message : String(err));
  return 1;
}

/** A flag's comma-separated value with an env fallback → split, trim, drop
 * empties. Shared by the local turn's `--ext` and `--skill` resource-dir lists. */
function parseCommaList(flag: string | boolean | undefined, envFallback: string | undefined): string[] {
  const raw = typeof flag === "string" ? flag : envFallback;
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function cmdNew(args: string[], flags: Flags, output: Output): Promise<number> {
  const repoId = args[0];
  if (!repoId) {
    output.error("Usage: ideaspaces conversation new <repo_id> [--name <name>] [--agent <node_id>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  const body: CreateConversationBody = {};
  if (typeof flags.name === "string") body.name = flags.name;
  // The agent Actor that runs the conversation. The server accepts it and will
  // honor it once backend agent-selection lands (matches is_web's pass-through).
  if (typeof flags.agent === "string") body.agent_node_id = flags.agent;
  try {
    const conv = await createConversation(config, repoId, body);
    output.result(conv, `Created conversation ${conv.name || "(untitled)"} (${conv.conversation_id})`);
    return 0;
  } catch (err) {
    return reportError(err, output);
  }
}

async function cmdParticipants(args: string[], output: Output): Promise<number> {
  const [repoId, convId] = args;
  if (!repoId || !convId) {
    output.error("Usage: ideaspaces conversation participants <repo_id> <conversation_id>");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  try {
    const res = await listParticipants(config, repoId, convId);
    output.result(
      res,
      res.participants.length
        ? res.participants.map((p) => `${p.participant} — ${p.role}`).join("\n")
        : "No participants.",
    );
    return 0;
  } catch (err) {
    return reportError(err, output);
  }
}

async function cmdAdd(args: string[], flags: Flags, output: Output): Promise<number> {
  const [repoId, convId, actor] = args;
  if (!repoId || !convId || !actor) {
    output.error(
      "Usage: ideaspaces conversation add <repo_id> <conversation_id> <username|principal> [--role member|reader]",
    );
    return 1;
  }
  const role = parseRole(flags.role);
  if (role === null) {
    output.error("--role must be 'member' or 'reader'.");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  const participant = toPrincipal(actor);
  try {
    const p = await addParticipant(config, repoId, convId, participant, role);
    output.result(p, `Added ${p.participant} as ${p.role}`);
    return 0;
  } catch (err) {
    return reportError(err, output);
  }
}

async function cmdRemove(args: string[], output: Output): Promise<number> {
  const [repoId, convId, actor] = args;
  if (!repoId || !convId || !actor) {
    output.error(
      "Usage: ideaspaces conversation remove <repo_id> <conversation_id> <username|principal>",
    );
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  const participant = toPrincipal(actor);
  try {
    const p = await removeParticipant(config, repoId, convId, participant);
    output.result(p, `Removed ${participant}`);
    return 0;
  } catch (err) {
    return reportError(err, output);
  }
}

async function cmdMembers(args: string[], output: Output): Promise<number> {
  const repoId = args[0];
  if (!repoId) {
    output.error("Usage: ideaspaces conversation members <repo_id>");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  try {
    const members = await fetchRepoMembers(config, repoId);
    output.result(
      { repo_id: repoId, members },
      members.length
        ? members.map((m) => `${m.username ?? m.email ?? `user ${m.user_id}`} — ${m.role}`).join("\n")
        : "No members.",
    );
    return 0;
  } catch (err) {
    return reportError(err, output);
  }
}

async function cmdSend(args: string[], flags: Flags, output: Output): Promise<number> {
  const [repoId, convId] = args;
  if (!repoId || !convId) {
    output.error(
      "Usage: ideaspaces conversation send <repo_id> <conversation_id> --message <text> [--model opus] [--thinking]",
    );
    return 1;
  }
  const message = typeof flags.message === "string" ? flags.message : undefined;
  if (!message) {
    output.error("A message is required: --message <text>");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  const body = {
    message,
    ...(typeof flags.model === "string" ? { model_tier: flags.model } : {}),
    // `--thinking` parses to boolean true; `--thinking=true` to the string "true".
    ...(flags.thinking === true || flags.thinking === "true" ? { thinking: true } : {}),
  };

  // Cancel propagation: a SIGINT/SIGTERM (the desktop killing the sidecar) aborts
  // the stream AND tells the server to stop the turn — killing the CLI alone
  // wouldn't, since the turn runs server-side past disconnect. Guarded so both
  // signals (or a repeat) don't fire a second cancel.
  const controller = new AbortController();
  let signalled = false;
  const onSignal = () => {
    if (signalled) return;
    signalled = true;
    controller.abort();
    void cancelConversationTurn(config, repoId, convId).catch(() => {});
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // A streaming verb: emit one JSON object per line as events arrive (not the
    // usual single result), so the desktop can read it incrementally.
    for await (const event of streamConversationMessage(config, repoId, convId, body, controller.signal)) {
      process.stdout.write(JSON.stringify(event) + "\n");
    }
    return 0;
  } catch (err) {
    if (controller.signal.aborted) return 0; // cancelled cleanly
    return reportError(err, output);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// `send --local <conv>` runs a turn on a LOCAL pi runtime (not the remote
// Keeper), context-rooted at cwd (a workspace that may mount repos), resuming
// the conversation's pi session. Emits the same Keeper JSON-lines contract as
// remote `send`, so any client renders it identically.
async function cmdSendLocal(flags: Flags, output: Output): Promise<number> {
  const message = typeof flags.message === "string" ? flags.message : undefined;
  if (!message) {
    output.error("A message is required: --message <text>");
    return 1;
  }
  // Both extensions: pi-is-space (Space) + pi-local-context (conversation). Until
  // distribution bundles them (D1), the caller supplies the paths.
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
    return reportError(err, output);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// `new --local` mints a local conversation id (= pi session id). The session
// is created lazily on the first `send --local` (pi's --session-id creates it),
// then named from the first message. Context-rooted; no repo, no server.
function cmdNewLocal(output: Output): number {
  const id = mintConversationId();
  output.result({ conversation_id: id }, `Created local conversation ${id}`);
  return 0;
}

// `get --local --conversation <id>` reads the context's pi session JSONL and
// returns the same ConversationDetail shape as the remote get. Id via
// --conversation (a bare positional after --local is swallowed by the parser).
function cmdGetLocal(flags: Flags, output: Output): number {
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

async function cmdGet(args: string[], output: Output): Promise<number> {
  const [repoId, convId] = args;
  if (!repoId || !convId) {
    output.error("Usage: ideaspaces conversation get <repo_id> <conversation_id>");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  try {
    const detail = await getConversation(config, repoId, convId);
    output.result(
      detail,
      detail.history.length
        ? detail.history
            .map((m) => {
              const preview = m.content.replace(/\s+/g, " ");
              return `${m.role}: ${preview.length > 80 ? preview.slice(0, 79) + "…" : preview}`;
            })
            .join("\n")
        : "No messages yet.",
    );
    return 0;
  } catch (err) {
    return reportError(err, output);
  }
}

async function cmdCancel(args: string[], output: Output): Promise<number> {
  const [repoId, convId] = args;
  if (!repoId || !convId) {
    output.error("Usage: ideaspaces conversation cancel <repo_id> <conversation_id>");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  try {
    const res = await cancelConversationTurn(config, repoId, convId);
    output.result(res, `Cancel: ${res.status}`);
    return 0;
  } catch (err) {
    return reportError(err, output);
  }
}

// Bare usage — `main.ts` adds the "Usage:" label for `--help`; the error path
// adds it explicitly. Matches the other commands' `usage:` fields.
const USAGE =
  "ideaspaces conversation <new|participants|add|remove|members|send|get|cancel> … (send --local for a local pi turn)";

export const conversationCommand: CommandDef = {
  name: "conversation",
  description: "Create a conversation and manage its participants",
  usage: USAGE,
  examples: [
    "ideaspaces conversation new repo_abc --name 'Kickoff'",
    "ideaspaces conversation new repo_abc --agent agent_node_xyz  # pick the agent",
    "ideaspaces conversation members repo_abc          # who you can add",
    "ideaspaces conversation add repo_abc c_123 alice  # add a person",
    "ideaspaces conversation participants repo_abc c_123",
    "ideaspaces conversation remove repo_abc c_123 alice",
    "ideaspaces conversation send repo_abc c_123 --message 'Hi'  # streams JSON lines",
    "ideaspaces conversation send --local --context /ws --conversation c1 --message 'Hi' --ext a,b --skill a/skills,b/skills  # local pi turn",
    "ideaspaces conversation get repo_abc c_123        # detail + history",
    "ideaspaces conversation cancel repo_abc c_123     # stop the active turn",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    switch (sub) {
      case "new":
        return flags.local ? cmdNewLocal(output) : cmdNew(rest, flags, output);
      case "participants":
        return cmdParticipants(rest, output);
      case "add":
        return cmdAdd(rest, flags, output);
      case "remove":
        return cmdRemove(rest, output);
      case "members":
        return cmdMembers(rest, output);
      case "send":
        return flags.local ? cmdSendLocal(flags, output) : cmdSend(rest, flags, output);
      case "get":
        return flags.local ? cmdGetLocal(flags, output) : cmdGet(rest, output);
      case "cancel":
        return cmdCancel(rest, output);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};
