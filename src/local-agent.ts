/**
 * The local-agent bridge — run a turn on a local pi runtime and emit it in the
 * Keeper transcript vocabulary, so every client renders a local turn the same
 * way it renders a remote Keeper turn.
 *
 * Spawn `pi --mode rpc` on the workspace context (cwd) with **both** extensions
 * (`-e pi-is-space -e pi-local-context`), resuming the conversation's pi session
 * (`--session-id <conv> --session-dir <root>/.pi/sessions`) so turns have
 * continuity. pi is an external runtime, shelled like git — no npm coupling. We
 * send one `prompt`, read pi's `AgentEvent` stream off stdout as JSON-lines, and
 * translate it with the SDK's `KeeperTranslator`. The connector-specific
 * `harvestWorkspace` lives here (it knows pi-is-space's tools); the generic fold
 * lives in the SDK.
 *
 * This is the runner behind `conversation send --local` (B1). pi RPC events are
 * top-level JSON objects on stdout, interleaved with command `response` acks and
 * fire-and-forget `extension_ui_request` chrome (setStatus/setWidget) — we feed
 * the agent events to the translator and ignore the rest.
 *
 * First-message naming: if the resumed session is still unnamed, derive a name
 * from this message (heuristic — swappable for a small titling call later) and
 * `set_session_name`. It stays freely updatable by the user or the agent via
 * pi-local-context's `context_conversation`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /** The workspace/context root (cwd) — an ideaspace that may mount repos. */
  repoPath: string;
  /** The user's message for this turn. */
  message: string;
  /** Extensions to load, in order — pi-is-space (Space) + pi-local-context. */
  extensionPaths: string[];
  /** Skill dirs to load. Separate from extensions: `--extension` loads code but
   * NOT the package's `skills` (pi's loader ignores `manifest.skills`), and a
   * shipped app can't rely on `pi install` writing them into `~/.pi`. Forward
   * them explicitly so the intent-layer skills reach pi. Empty in dev when the
   * user has already `pi install`ed the extensions. */
  skillPaths?: string[];
  /** Conversation id = pi session id; reported in `message_start`, resumed each turn. */
  conversationId: string;
  /** Where pi stores/looks up sessions — the context's gitignored session dir. */
  sessionDir: string;
  /** Keeper model-tier label for the events. Default "local". */
  modelTier?: string;
  /** pi model pattern (`--model`), if overriding pi's configured default. */
  piModel?: string;
  /** pi executable. Default "pi" (from PATH). */
  piBin?: string;
  /** Abort the turn (SIGINT/desktop kill) — kills pi and emits `cancelled`. */
  signal?: AbortSignal;
}

/** A conversation name derived from the first message — first non-empty line,
 * whitespace-collapsed, capped. Swappable for a small titling call later. */
export function deriveConversationName(message: string): string {
  const line = message.split("\n").find((l) => l.trim()) ?? message;
  const clean = line.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled";
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

/** Ensure the session dir exists and can never be committed (self-ignoring),
 * so conversation logs stay local working process regardless of repo config. */
function ensureSessionDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

/**
 * The `pi --mode rpc` argv for a turn. Pure, so the extension/skill/model
 * wiring is unit-testable. Skills ride `--skill` separately from `--extension`
 * because pi's loader doesn't register a package's `manifest.skills` — a shipped
 * app forwards the skill dirs explicitly (dev leaves them empty, `pi install`ed).
 */
export function buildPiArgs(opts: LocalTurnOptions): string[] {
  const args = [
    "--mode", "rpc",
    "--session-id", opts.conversationId,
    "--session-dir", opts.sessionDir,
    "-a",
  ];
  // The extensions we pass are authoritative: a local turn must load exactly
  // these (the desktop's bundled, pinned set), NOT also whatever the user has
  // globally `pi install`ed — the same extension loaded twice hard-errors on
  // tool-name conflicts. `--no-extensions` disables discovery of global/project
  // extensions while explicit `--extension` paths still load (pi's documented
  // behavior; resource-loader gates on `noExtensions`). Only when we actually
  // provide extensions — otherwise we'd suppress everything and load none.
  if (opts.extensionPaths.length) args.push("--no-extensions");
  for (const ext of opts.extensionPaths) args.push("--extension", ext);
  for (const skill of opts.skillPaths ?? []) args.push("--skill", skill);
  if (opts.piModel) args.push("--model", opts.piModel);
  return args;
}

/**
 * Run one local turn, yielding Keeper stream events as they arrive. Resumes the
 * conversation's pi session for continuity. Ends after `turn_complete`
 * (agent_end), `cancelled` (abort), or `error` (failed prompt / pi exit).
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

  ensureSessionDir(opts.sessionDir);

  const args = buildPiArgs(opts);
  const pi = spawn(opts.piBin ?? "pi", args, { cwd: opts.repoPath, stdio: ["pipe", "pipe", "pipe"] });

  let stderr = "";
  pi.stderr.on("data", (d) => {
    stderr += String(d);
  });

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    try {
      pi.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Ask whether the session is already named before we prompt, so we can derive
  // a first-message name only for a fresh conversation.
  let sessionName: string | undefined;
  const send = (obj: Record<string, unknown>): void => {
    try {
      pi.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* pi gone */
    }
  };
  send({ type: "get_state", id: "__state" });
  send({ type: "prompt", message: opts.message, id: "p1" });

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
        if (type === "response" && msg.command === "get_state" && msg.success !== false) {
          const data = msg.data as { sessionName?: string } | undefined;
          sessionName = data?.sessionName;
        }
        if (type === "response" && msg.success === false && msg.command === "prompt") {
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
      if (type === "agent_end") {
        // Name a still-unnamed conversation from its first message before we exit.
        if (!sessionName || !sessionName.trim()) {
          send({ type: "set_session_name", name: deriveConversationName(opts.message), id: "__name" });
          await new Promise((r) => setTimeout(r, 250)); // let pi persist it
        }
        return;
      }
    }
    // stdout closed without a terminal event.
    if (aborted && !translator.isEnded) {
      yield translator.cancelled("aborted");
    } else if (!translator.isEnded) {
      yield translator.error("pi_exit", stderr.trim() || "pi ended without completing the turn");
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    rl.close();
    try {
      pi.stdin.end();
    } catch {
      /* already closed */
    }
    pi.kill("SIGTERM");
  }
}
