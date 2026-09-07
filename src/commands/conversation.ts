import {
  cancelConversationTurn,
  createConversation,
  getConversation,
  streamConversationMessage,
  UnauthorizedError,
  type ApiConfig,
  type CreateConversationBody,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

/**
 * The LOCAL (Pi) side of `conversation` — the `--local` handlers, injected so the
 * core command stays Pi-free. The Pi module implements this; the router wires it.
 * Core dispatches `--local` here and never imports the Pi runtime itself.
 */
export interface LocalConversationOps {
  send(flags: Flags, output: Output): Promise<number>;
  createNew(output: Output): number;
  get(flags: Flags, output: Output): number;
  /** `conversations --local` (the plural list command shares this seam). */
  list(flags: Flags, output: Output): number;
}

// `conversations` (plural) lists a repo's conversations; `conversation`
// (singular) operates on one private conversation.

const RETIRED_PARTICIPANT_COMMANDS = new Set(["participants", "add", "remove", "members"]);

function rejectRetiredParticipantCommand(sub: string, output: Output): number {
  output.error(
    `The \`conversation ${sub}\` command was removed. ` +
      "Conversations are private to one person and their selected agent. " +
      "Use `ideaspaces share person <email|@handle>` or `ideaspaces share team <hostname>` " +
      "to share Content; collaborate through Inbox.",
  );
  return 1;
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
    output.error("Usage: ideaspaces conversation new <repo_id> [--name <name>] [--agent <node_id>]");
    return 1;
  }
  const config = requireConfig(output);
  if (!config) return 1;

  const body: CreateConversationBody = {};
  if (typeof flags.name === "string") body.name = flags.name;
  // The agent Actor that runs the conversation. The server accepts it and will
  // honor it once backend agent-selection lands.
  if (typeof flags.agent === "string") body.agent_node_id = flags.agent;
  try {
    const conv = await createConversation(config, repoId, body);
    output.result(conv, `Created conversation ${conv.name || "(untitled)"} (${conv.conversation_id})`);
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
  "ideaspaces conversation <new|send|get|cancel> … (send --local for a local pi turn)";

/**
 * Build the `conversation` command. `local` supplies the `--local` handlers (the
 * Pi runtime); the router injects the Pi implementation. Core never imports Pi.
 */
export function makeConversationCommand(local: LocalConversationOps): CommandDef {
  return {
    name: "conversation",
    description: "Create and run a private conversation",
    usage: USAGE,
    examples: [
      "ideaspaces conversation new repo_abc --name 'Kickoff'",
      "ideaspaces conversation new repo_abc --agent agent_node_xyz  # pick the agent",
      "ideaspaces conversation send repo_abc c_123 --message 'Hi'  # streams JSON lines",
      "ideaspaces conversation send --local --context /ws --conversation c1 --message 'Hi' --map maps/research.md --ext a,b --skill a/skills,b/skills --pi-bin /path/pi --pi-model sonnet --pi-thinking high  # local pi turn over a map-note",
      "ideaspaces conversation send --local --context /agents/desktop --working-root /work --focus note.md --session-dir /work/.pi/sessions --conversation c1 --message 'Explain this' --ext a,b  # POV launch; orientation is separate from the user message",
      "ideaspaces conversation get repo_abc c_123        # detail + history",
      "ideaspaces conversation cancel repo_abc c_123     # stop the active turn",
    ],
    async run(args, flags, global: GlobalFlags) {
      const output = createOutput(global);
      const [sub, ...rest] = args;
      if (RETIRED_PARTICIPANT_COMMANDS.has(sub ?? "")) {
        return rejectRetiredParticipantCommand(sub, output);
      }
      switch (sub) {
        case "new":
          return flags.local ? local.createNew(output) : cmdNew(rest, flags, output);
        case "send":
          return flags.local ? local.send(flags, output) : cmdSend(rest, flags, output);
        case "get":
          return flags.local ? local.get(flags, output) : cmdGet(rest, output);
        case "cancel":
          return cmdCancel(rest, output);
        default:
          output.error(`Usage: ${USAGE}`);
          return 1;
      }
    },
  };
}
