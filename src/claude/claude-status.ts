/**
 * `ideaspaces claude-status` — is the user's Claude Code usable for a local
 * turn? The sibling of `pi-status`, and the detection contract for "Connect
 * Claude Code": a client asks the sidecar, which already spawns `claude` for
 * turns, instead of probing a user-supplied binary path itself.
 *
 * Two checks, both answered by the binary and never by its files:
 *
 *   - **binary** — does `--claude-bin` (else `claude` on PATH — the same
 *                  resolution `conversation send --local --runtime=claude`
 *                  uses) run, and what does `--version` say
 *   - **login**  — `claude auth status --json`, Claude Code's own report of
 *                  whether it is signed in and how. Nothing under `~/.claude`
 *                  is read here; the user signs in through Claude Code's flow
 *                  and this only asks the binary what that flow left behind.
 *
 * The probe runs under the same environment a turn would (`--claude-auth`,
 * default `login`, scrubs the direct API-key variables), so an ambient
 * `ANTHROPIC_API_KEY` cannot report a login that the turn would then refuse.
 * Neither probe makes a model call, so a plan limit — which Claude Code
 * reports as ordinary assistant text, not an error — cannot masquerade as
 * readiness, and no usage is spent on detection.
 */

import { spawnSync } from "node:child_process";
import { probeBinary, type ProbedBinary } from "../local/probe-binary.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";
import { CLAUDE_AUTH_MODES, buildClaudeEnv, isValidClaudeAuthMode, type ClaudeAuthMode } from "./local-agent.js";
import {
  getClaudeRoster,
  type ClaudeCapabilities,
  type ClaudeModel,
} from "./claude-models.js";

export type ClaudeBinary = ProbedBinary;

export interface ClaudeLogin {
  /** Claude Code's answer, or null when the binary could not give one (see `detail`). */
  loggedIn: boolean | null;
  /** How it is signed in as Claude Code names it — `claude.ai`, `api_key`, `none`, … */
  method: string | null;
  /** Plan hint when signed in through claude.ai (`max`, `pro`, …), never a credential. */
  subscription: string | null;
  /** Why `loggedIn` is null: the binary is absent, or predates `claude auth status`. */
  detail: string | null;
}

export interface ClaudeStatus {
  binary: ClaudeBinary;
  login: ClaudeLogin;
  /** The auth path the probe ran under — the same one a turn would use. */
  auth: ClaudeAuthMode;
  /** The "Connect Claude Code" bar: a usable binary that reports itself signed in. */
  ready: boolean;
  /** The model roster the installed binary accepts. */
  models: ClaudeModel[];
  /** Compaction and auto-compact bounds. */
  capabilities: ClaudeCapabilities;
  /** The binary version the roster and capabilities were verified against. */
  verifiedVersion: string;
}

/** The fields of `claude auth status --json` this verb reads. */
interface ClaudeAuthReport {
  loggedIn?: unknown;
  authMethod?: unknown;
  subscriptionType?: unknown;
}

/** Parse the stdout of `claude auth status --json`. Null when it is not the
 * report — an older Claude Code prints `error: unknown command 'auth'` to stderr
 * and nothing here. The exit code is deliberately not consulted: a signed-out
 * binary exits 1 with a perfectly good report on stdout. */
export function parseClaudeAuthReport(stdout: string): ClaudeAuthReport | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as ClaudeAuthReport).loggedIn !== "boolean") return null;
    return parsed as ClaudeAuthReport;
  } catch {
    return null;
  }
}

/** Pure status derivation — the spawns happen in the command and their raw
 * results are passed in, so every state is unit-testable without a `claude`. */
export function deriveClaudeStatus(input: {
  binary: ClaudeBinary;
  /** stdout of `claude auth status --json`, whatever its exit code; null when it could not be run. */
  authStdout: string | null;
  auth: ClaudeAuthMode;
}): ClaudeStatus {
  const { binary, auth } = input;
  let login: ClaudeLogin;
  if (!binary.present) {
    login = { loggedIn: null, method: null, subscription: null, detail: `${binary.path} is not installed or not on PATH` };
  } else {
    const named = `${binary.path}${binary.version ? ` ${binary.version}` : ""}`;
    const report = input.authStdout === null ? null : parseClaudeAuthReport(input.authStdout);
    if (report) {
      login = {
        loggedIn: report.loggedIn === true,
        method: typeof report.authMethod === "string" ? report.authMethod : null,
        subscription: typeof report.subscriptionType === "string" ? report.subscriptionType : null,
        detail: null,
      };
    } else {
      // Two ways to have no report: the second spawn failed outright after
      // `--version` ran (rare — a binary that vanished or hung), or it ran and
      // printed no report (a Claude Code older than the `auth` subcommand).
      const detail =
        input.authStdout === null
          ? `could not run \`${named} auth status\``
          : `${named} did not report its sign-in state; \`claude auth status\` needs a newer Claude Code`;
      login = { loggedIn: null, method: null, subscription: null, detail };
    }
  }
  const roster = getClaudeRoster(binary.version);
  return {
    binary,
    login,
    auth,
    ready: binary.present && login.loggedIn === true,
    models: roster.models,
    capabilities: roster.capabilities,
    verifiedVersion: roster.verifiedVersion,
  };
}

/** Ask the binary for its sign-in state. Returns stdout whatever the exit code. */
function probeLogin(claudeBin: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const res = spawnSync(claudeBin, ["auth", "status", "--json"], { encoding: "utf8", timeout: 5000, env });
    if (res.error) return null;
    return res.stdout ?? "";
  } catch {
    return null;
  }
}

function formatHuman(s: ClaudeStatus): string {
  const out: string[] = [];
  out.push(
    s.binary.present
      ? `Claude Code: present${s.binary.version ? ` (${s.binary.version})` : ""} — ${s.binary.path}`
      : `Claude Code: not found (${s.binary.path}). Install Claude Code, or pass --claude-bin <path>.`,
  );
  if (s.login.loggedIn === true) {
    const how = [s.login.method, s.login.subscription].filter(Boolean).join(", ");
    out.push(`Signed in: yes${how ? ` (${how})` : ""}`);
  } else if (s.login.loggedIn === false) {
    out.push("Signed in: no — run `claude` once in a terminal and sign in.");
  } else {
    out.push(`Signed in: unknown — ${s.login.detail}`);
  }
  out.push(`Ready: ${s.ready ? "yes" : "no"}`);
  if (s.models && s.models.length) {
    const summary = s.models
      .filter((m) => m.ref)
      .map(
        (m) =>
          `${m.name} ${
            m.contextWindow >= 1_000_000
              ? `${(m.contextWindow / 1_000_000).toFixed(m.contextWindow % 1_000_000 === 0 ? 0 : 1)}M`
              : `${Math.round(m.contextWindow / 1000)}k`
          }`,
      )
      .join(", ");
    out.push(`Models: ${s.models.length} available (${summary})`);
  }
  return out.join("\n");
}

export const claudeStatusCommand: CommandDef = {
  name: "claude-status",
  description: "Is your Claude Code usable for a local agent? (binary, version, signed in)",
  usage: "ideaspaces claude-status [--claude-bin <path>] [--claude-auth login|api-key] [--json]",
  examples: [
    "ideaspaces claude-status",
    "ideaspaces claude-status --json",
    "ideaspaces claude-status --claude-bin /opt/homebrew/bin/claude --json",
    "ideaspaces claude-status --claude-auth api-key  # count an ANTHROPIC_API_KEY as signed in",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);

    // Same resolution as `conversation send --local --runtime=claude`: the flag,
    // else `claude` from PATH. The desktop passes the path from its settings.
    const claudeBin = typeof flags["claude-bin"] === "string" ? flags["claude-bin"] : "claude";
    const auth = flags["claude-auth"] === undefined ? "login" : flags["claude-auth"];
    if (typeof auth !== "string" || !isValidClaudeAuthMode(auth)) {
      output.error(`Invalid auth mode "${String(auth)}". Valid values: ${CLAUDE_AUTH_MODES.join(", ")}`);
      return 1;
    }
    const env = buildClaudeEnv(auth);

    const binary = probeBinary(claudeBin, env);
    const authStdout = binary.present ? probeLogin(claudeBin, env) : null;

    const status = deriveClaudeStatus({ binary, authStdout, auth });
    output.result(status, formatHuman(status));
    return 0;
  },
};
