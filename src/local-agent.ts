/**
 * The local-agent bridge — run a turn on a local pi runtime and emit it in the
 * Keeper transcript vocabulary, so every client renders a local turn the same
 * way it renders a remote Keeper turn.
 *
 * Spawn `pi --mode rpc --extension <pi-is-space>` (pi is an external runtime,
 * shelled like git — no npm coupling), send one `prompt`, read pi's `AgentEvent`
 * stream off stdout as JSON-lines, and translate it with the SDK's
 * `KeeperTranslator`. The connector-specific `harvestWorkspace` lives here (it
 * knows pi-is-space's tools); the generic fold lives in the SDK.
 *
 * This is the runner behind `conversation send-local` (the A3 dogfood) and, next,
 * `conversation send --local` (B1). pi RPC events are top-level JSON objects on
 * stdout, interleaved with command `response` acks and fire-and-forget
 * `extension_ui_request` chrome (setStatus/setWidget) — we feed the agent events
 * to the translator and ignore the rest.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  KeeperTranslator,
  emptyWorkspaceSurface,
  type KeeperStreamEvent,
  type KeeperWorkspaceSurface,
  type PiAgentEvent,
  type ToolInvocation,
} from "@ideaspaces/sdk";

/** Non-agent stdout kinds we skip (command acks + fire-and-forget UI chrome). */
const NON_AGENT_TYPES = new Set(["response", "extension_ui_request"]);

/**
 * Classify a turn's pi-is-space tool calls into the workspace surface. Connector
 * knowledge: `is_write`/`is_commit` change notes; `is_navigate`/`read` reference
 * them. Errored calls touch nothing. (Created-vs-modified is not yet
 * distinguished — both count as "changed"; refine when is_write reports it.)
 */
export function harvestWorkspace(tools: ToolInvocation[]): KeeperWorkspaceSurface {
  const ws = emptyWorkspaceSurface();
  const add = (arr: string[], p: unknown): void => {
    if (typeof p === "string" && p && !arr.includes(p)) arr.push(p);
  };
  for (const t of tools) {
    if (t.isError) continue;
    const path = t.args.path;
    switch (t.name) {
      case "is_write":
        add(ws.modified, path);
        break;
      case "is_commit":
        if (Array.isArray(t.args.paths)) for (const p of t.args.paths) add(ws.modified, p);
        else add(ws.modified, path);
        break;
      case "is_navigate":
      case "read":
        add(ws.read, path);
        break;
      default:
        break;
    }
  }
  return ws;
}

/** The last position an `is_navigate` moved to, for `turn_complete.position`. */
function lastPosition(tools: ToolInvocation[]): string {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].name === "is_navigate" && !tools[i].isError) {
      const p = tools[i].args.path;
      if (typeof p === "string") return p;
    }
  }
  return "";
}

export interface LocalTurnOptions {
  /** Working directory (the local ideaspace repo). */
  repoPath: string;
  /** The user's message for this turn. */
  message: string;
  /** Absolute path to the pi-is-space extension entry (its `src/index.ts`). */
  extensionPath: string;
  /** Conversation id reported in `message_start` (a pi session id, or minted). */
  conversationId: string;
  /** Keeper model-tier label for the events. Default "local". */
  modelTier?: string;
  /** pi model pattern (`--model`), if overriding pi's configured default. */
  piModel?: string;
  /** pi executable. Default "pi" (from PATH). */
  piBin?: string;
}

/**
 * Run one local turn, yielding Keeper stream events as they arrive. Ends after
 * `turn_complete` (agent_end), or `error` on a failed prompt / pi exit.
 */
export async function* runLocalTurn(opts: LocalTurnOptions): AsyncGenerator<KeeperStreamEvent> {
  const modelTier = opts.modelTier ?? "local";
  // Captured at agent_end (when harvest runs) so we can patch position on the
  // way out — the translator snapshots its config, so we can't feed it lazily.
  let turnTools: ToolInvocation[] = [];
  const translator = new KeeperTranslator({
    conversationId: opts.conversationId,
    modelTier,
    harvestWorkspace: (tools) => {
      turnTools = tools;
      return harvestWorkspace(tools);
    },
  });

  const args = ["--mode", "rpc", "--extension", opts.extensionPath, "-a"];
  if (opts.piModel) args.push("--model", opts.piModel);
  const pi = spawn(opts.piBin ?? "pi", args, { cwd: opts.repoPath, stdio: ["pipe", "pipe", "pipe"] });

  let stderr = "";
  pi.stderr.on("data", (d) => {
    stderr += String(d);
  });

  pi.stdin.write(`${JSON.stringify({ type: "prompt", message: opts.message, id: "p1" })}\n`);

  const rl = readline.createInterface({ input: pi.stdout, terminal: false });
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        continue; // non-JSON stdout noise
      }
      const type = typeof msg.type === "string" ? msg.type : "";
      if (NON_AGENT_TYPES.has(type)) {
        if (type === "response" && msg.success === false) {
          yield translator.error("pi_error", String(msg.error ?? "prompt failed"));
          return;
        }
        continue; // command acks + UI chrome
      }
      for (const ke of translator.translate(msg as unknown as PiAgentEvent)) {
        // Fill position from the turn's last navigate (translator can't do it lazily).
        if (ke.type === "turn_complete") ke.result.position = lastPosition(turnTools);
        yield ke;
      }
      if (type === "agent_end") return; // turn complete
    }
    // stdout closed without agent_end — surface it.
    if (!translator.isEnded) {
      yield translator.error("pi_exit", stderr.trim() || "pi ended without completing the turn");
    }
  } finally {
    rl.close();
    try {
      pi.stdin.end();
    } catch {
      /* already closed */
    }
    pi.kill("SIGTERM");
  }
}
