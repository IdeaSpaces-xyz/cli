/**
 * The Claude Code runner — run one turn on the user's own `claude` binary and
 * emit it in the Keeper transcript vocabulary, the same nine events the pi
 * runner (`src/pi/local-agent.ts`) produces, so the desktop transcript and the
 * reducer above `conversation send --local` do not know which runtime spoke.
 *
 * Spawn `claude -p --verbose --output-format stream-json --include-partial-messages`
 * in the POV root, resuming the conversation's Claude session (`--resume <id>`;
 * `--session-id <id>` the first time, which creates it), with the working root
 * allowed through `--add-dir`. The prompt rides stdin. Claude Code is the user's
 * own install — never bundled, never modified, signed in through its own flow —
 * so there is no `--ext`/`--skill` wiring: whatever plugin, skills and memory the
 * user's Claude Code carries come along by construction.
 *
 * Auth is the user's Claude login unless the caller asks for `api-key`: an
 * ambient `ANTHROPIC_API_KEY` in the environment would silently switch billing
 * from their plan to pay-per-token, so the login path scrubs the direct API-key
 * variables from the child. Provider routing the user set up on purpose
 * (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, and their cloud
 * credentials) is their Claude Code's configuration and passes through — it is
 * not ambient, and removing it would break the install they signed in to.
 *
 * Sessions live where Claude Code keeps them (`~/.claude/projects/<slug>/`),
 * outside the space; the readers in `./local-conversations.ts` find them there.
 */

import { spawn } from "node:child_process";
import {
  ClaudeTranslator,
  parseClaudeStreamLine,
  type KeeperStreamEvent,
  type ToolInvocation,
} from "@ideaspaces/sdk";
import { readJsonLines } from "../local/jsonl.js";
import { discloseLaunch, resolveAddedDirs } from "../local/send-options.js";
import { harvestLocalFiles } from "../local/workspace-files.js";
import { claudeSessionFile } from "./local-conversations.js";
import { claudeToolBaseName, normalizeClaudeInvocation } from "./tool-names.js";
import { launchMapEnv } from "../local/address-read.js";

/** Claude Code's `--permission-mode` choices (`claude --help`, 2.1.270). Headless
 * runs never prompt — checked live: `manual` and `dontAsk` under `-p` run or deny
 * a tool and close the turn, they do not wait — so the mode is the whole approval
 * policy for the turn. */
export const CLAUDE_PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export function isValidClaudePermissionMode(mode: string): mode is ClaudePermissionMode {
  return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode);
}

/** `--effort` choices verified against Claude Code 2.1.284's --help. Older
 * versions may not support the flag; their rejection is surfaced as a failed run. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];
export function isValidClaudeEffort(value: string): value is ClaudeEffort {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** How the spawned Claude Code authenticates. `login` is the user's own Claude
 * sign-in (the default, and the only path the desktop offers); `api-key` lets an
 * `ANTHROPIC_API_KEY` in the environment through. */
export const CLAUDE_AUTH_MODES = ["login", "api-key"] as const;
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number];

export function isValidClaudeAuthMode(mode: string): mode is ClaudeAuthMode {
  return (CLAUDE_AUTH_MODES as readonly string[]).includes(mode);
}

/** Check if `--autocompact` argument is valid ('auto', or 100k–1M tokens).
 * Verified against `claude --help` (2.1.278): "Auto-compact window size (auto, or 100k–1M tokens)".
 * Claude Code accepts bare numbers between 100 and 1000 as shorthand for thousands of tokens (e.g. 200 = 200k). */
export function isValidClaudeAutocompact(val: unknown): boolean {
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  if (trimmed === "auto") return true;
  const m = /^(\d+)(k|m)?$/i.exec(trimmed);
  if (!m) return false;
  let tokens = parseInt(m[1], 10);
  const suffix = (m[2] ?? "").toLowerCase();
  if (suffix === "k") tokens *= 1_000;
  else if (suffix === "m") tokens *= 1_000_000;
  else if (tokens >= 100 && tokens <= 1_000) tokens *= 1_000; // Claude Code CLI shorthand (100–1000 = k)
  return tokens >= 100_000 && tokens <= 1_000_000;
}

/** The direct API-key variables — the ambient ones that move billing off a plan. */
const API_KEY_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export interface ClaudeTurnOptions {
  /** The selected POV root and Claude Code process cwd. */
  repoPath: string;
  /** The selected material root, independent of the POV. Defaults to repoPath. */
  workingRoot?: string;
  /** Additional directories to grant Claude Code access to (--add-dir). */
  addedDirs?: string[];
  /** Allowed tools by name/pattern (--allowedTools). When omitted, defaults by purpose. */
  allowedTools?: string[];
  /** The user's message for this turn. */
  message: string;
  /** Conversation id = Claude session id (a UUID); reported in `message_start`, resumed each turn. */
  conversationId: string;
  /** Whether the session already exists on disk — `--resume` if so, `--session-id` (create) if not.
   * Default: look it up under Claude Code's project dir for `repoPath`. */
  sessionExists?: boolean;
  /** Keeper model-tier label for the events. Default: the model Claude Code reports at init. */
  modelTier?: string;
  /** File-first Map rendered as user-authored navigation data for this launch. */
  mapOrientation?: string;
  /** The launch Map's absolute path: the default Map for address reads in the session. */
  mapPath?: string;
  /** Validated local working coordinates; appended to the system prompt, never to user messages. */
  launchOrientation?: string;
  /** Claude model alias or id (`--model`), if overriding the user's default. */
  model?: string;
  /** Approval policy for the headless turn. Default `acceptEdits`. */
  permissionMode?: ClaudePermissionMode;
  /** Agent run only: no human listener for permission requests (Claude Code 2.1.291). */
  permissionPromptsNone?: boolean;
  /** Restrict the headless child to built-in read tools, with no plugin MCP tools. */
  readOnly?: boolean;
  /** Claude Code's --effort, if supported by the installed version. */
  effort?: ClaudeEffort;
  /** Auth path. Default `login` — scrubs API-key variables from the child env. */
  auth?: ClaudeAuthMode;
  /** Claude Code executable. Default "claude" (from PATH). */
  claudeBin?: string;
  /** Auto-compact window size passed to Claude Code (`--autocompact <auto|tokens>`). */
  autocompact?: string;
  /** Abort the turn (SIGINT/desktop kill) — kills claude and emits `cancelled`. */
  signal?: AbortSignal;
}

/** The `claude -p` argv for a turn. Pure, so the flag wiring is unit-testable.
 * The prompt is not here — it rides stdin, so message length and quoting never
 * meet the argv limit. */
export function buildClaudeArgs(opts: ClaudeTurnOptions & { sessionExists: boolean }): string[] {
  const args = [
    "-p",
    "--verbose", // Claude Code refuses `-p --output-format stream-json` without it
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--permission-mode", opts.permissionMode ?? "acceptEdits",
  ];
  // Verified in Claude Code 2.1.291 --help. Desktop conversation send retains
  // its existing prompt policy; only agent run has no permission listener.
  if (opts.permissionPromptsNone) args.push("--permission-prompts", "none");
  args.push(opts.sessionExists ? "--resume" : "--session-id", opts.conversationId);
  const addedDirs = resolveAddedDirs(opts);
  for (const dir of addedDirs) {
    args.push("--add-dir", dir);
  }

  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.readOnly) {
    // --allowedTools is preapproval, never a restriction. Drop every MCP server
    // (including the plugin) and all non-read builtins for an actual ask boundary.
    args.push("--tools", "Read,Grep,Glob", "--strict-mcp-config");
  }
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }

  if (opts.autocompact) args.push("--autocompact", opts.autocompact);
  const orientation = [opts.mapOrientation, opts.launchOrientation].filter(Boolean).join("\n\n");
  if (orientation) args.push("--append-system-prompt", orientation);
  return args;
}

/**
 * The child environment: the caller's, minus the direct API-key variables unless `api-key` was
 * asked for, with this launch's Map — and never a launch Map inherited from the caller's own.
 */
export function buildClaudeEnv(auth: ClaudeAuthMode, base: NodeJS.ProcessEnv = process.env, mapPath?: string): NodeJS.ProcessEnv {
  const env = launchMapEnv(base, mapPath);
  if (auth === "login") for (const key of API_KEY_ENV) delete env[key];
  return env;
}

/** The last position an `is_navigate` moved to, for `turn_complete.position`. */
function lastPosition(tools: ToolInvocation[]): string {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (claudeToolBaseName(tools[i].name) === "is_navigate" && !tools[i].isError) {
      const p = tools[i].args.path;
      if (typeof p === "string") return p;
    }
  }
  return "";
}

/**
 * Run one Claude Code turn, yielding Keeper stream events as they arrive.
 * Ends after `turn_complete` (result), `cancelled` (abort), or `error`
 * (failed result / claude exit).
 */
export async function* runClaudeTurn(opts: ClaudeTurnOptions): AsyncGenerator<KeeperStreamEvent> {
  const sessionExists = opts.sessionExists ?? claudeSessionFile(opts.repoPath, opts.conversationId) !== null;
  let turnTools: ToolInvocation[] = [];
  const translator = new ClaudeTranslator({
    conversationId: opts.conversationId,
    modelTier: opts.modelTier,
    harvestWorkspace: (tools) => {
      turnTools = tools;
      return harvestLocalFiles(tools.map(normalizeClaudeInvocation), opts.repoPath, opts.workingRoot);
    },
  });

  const args = buildClaudeArgs({ ...opts, sessionExists });
  const claude = spawn(opts.claudeBin ?? "claude", args, {
    cwd: opts.repoPath,
    env: buildClaudeEnv(opts.auth ?? "login", process.env, opts.mapPath),
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  claude.stderr.on("data", (d) => {
    stderr += String(d);
  });
  let spawnError: Error | undefined;
  claude.on("error", (err) => {
    spawnError = err;
  });

  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    try {
      claude.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    claude.stdin.end(opts.message);
  } catch {
    /* claude gone — the stdout loop reports it */
  }

  const addedDirs = resolveAddedDirs(opts);
  const allowedTools = opts.allowedTools ?? (opts.readOnly ? ["Read", "Grep", "Glob"] : null);

  try {
    for await (const line of readJsonLines(claude.stdout)) {
      const record = parseClaudeStreamLine(line);
      if (!record) continue; // Claude Code prints some failures as prose before its result line
      for (const ke of translator.translate(record)) {
        if (ke.type === "message_start") {
          yield discloseLaunch(ke, {
            cwd: opts.repoPath, added_dirs: addedDirs,
            permission_mode: opts.permissionMode ?? "acceptEdits",
            allowed_tools: allowedTools ?? null, runtime: "claude",
            model: opts.model ?? ke.model_tier,
          });
          continue;
        }
        if (ke.type === "turn_complete") ke.result.position = lastPosition(turnTools);
        yield ke;
      }
      if (translator.isEnded) return;
    }
    // stdout closed without a terminal event.
    if (aborted && !translator.isEnded) {
      yield translator.cancelled("aborted");
    } else if (!translator.isEnded) {
      const reason = spawnError
        ? `Could not start ${opts.claudeBin ?? "claude"}: ${spawnError.message}`
        : stderr.trim() || "claude ended without completing the turn";
      yield translator.error("claude_exit", reason);
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    claude.kill("SIGTERM");
  }
}
