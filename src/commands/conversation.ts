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
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
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

async function cmdNew(args: string[], flags: Flags, output: Output): Promise<number> {
  const repoId = args[0];
  if (!repoId) {
    output.error("Usage: ideaspaces conversation new <repo_id> [--name <name>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  const name = typeof flags.name === "string" ? flags.name : undefined;
  try {
    const conv = await createConversation(config, repoId, name ? { name } : {});
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
    output.error("Usage: ideaspaces conversation send <repo_id> <conversation_id> --message <text>");
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
    ...(flags.thinking === true || flags.thinking === "true" ? { thinking: true } : {}),
  };

  // Cancel propagation: a SIGINT/SIGTERM (the desktop killing the sidecar) aborts
  // the stream AND tells the server to stop the turn — killing the CLI alone
  // wouldn't, since the turn runs server-side past disconnect.
  const controller = new AbortController();
  const onSignal = () => {
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
            .map((m) => `${m.role}: ${m.content.replace(/\s+/g, " ").slice(0, 80)}`)
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

const USAGE =
  "Usage: ideaspaces conversation <new|participants|add|remove|members|send|get|cancel> …";

export const conversationCommand: CommandDef = {
  name: "conversation",
  description: "Create a conversation and manage its participants",
  usage: USAGE,
  examples: [
    "ideaspaces conversation new repo_abc --name 'Kickoff'",
    "ideaspaces conversation members repo_abc          # who you can add",
    "ideaspaces conversation add repo_abc c_123 alice  # add a person",
    "ideaspaces conversation participants repo_abc c_123",
    "ideaspaces conversation remove repo_abc c_123 alice",
    "ideaspaces conversation send repo_abc c_123 --message 'Hi'  # streams JSON lines",
    "ideaspaces conversation get repo_abc c_123        # detail + history",
    "ideaspaces conversation cancel repo_abc c_123     # stop the active turn",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    switch (sub) {
      case "new":
        return cmdNew(rest, flags, output);
      case "participants":
        return cmdParticipants(rest, output);
      case "add":
        return cmdAdd(rest, flags, output);
      case "remove":
        return cmdRemove(rest, output);
      case "members":
        return cmdMembers(rest, output);
      case "send":
        return cmdSend(rest, flags, output);
      case "get":
        return cmdGet(rest, output);
      case "cancel":
        return cmdCancel(rest, output);
      default:
        output.error(USAGE);
        return 1;
    }
  },
};
