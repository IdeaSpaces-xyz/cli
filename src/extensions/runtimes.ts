/**
 * The impure half — spawn a runtime binary for its package/plugin commands and
 * turn the launch-set ids into what a turn passes: explicit `--extension` and
 * `--skill` paths for pi, an `enabledPlugins` map for Claude Code. Every spawn
 * goes through {@link runRuntime} so a missing binary reads as one sentence.
 */

import { spawnSync } from "node:child_process";
import { readApprovals, isApproved } from "./approvals.js";
import {
  CLAUDE_LIST_ARGS,
  claudeInstallArgs,
  claudeLaunchSettings,
  parseClaudePluginList,
  readClaudeAgentDeclarations,
} from "./claude-plugins.js";
import { CODEX_LIST_ARGS, parseCodexPluginList } from "./codex-plugins.js";
import type { AvailableExtension, ExtensionRow } from "./model.js";
import {
  PI_LIST_ARGS,
  parsePiList,
  piInstallArgs,
  piPackageName,
  piPackageSkillsDir,
  readPiAgentDeclarations,
} from "./pi-packages.js";
import { parseLaunchOverrides, resolveLaunch, type Refusal } from "./resolve.js";

export interface RuntimeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RuntimeSpawn {
  bin: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Installs clone and `npm install`; lists are quick. Default 30s. */
  timeoutMs?: number;
}

/** Run `<bin> <args>` to completion. ENOENT → a thrown error naming the binary,
 * since every caller would otherwise have to translate it. Non-zero exit is
 * returned, not thrown — the caller knows whether that is a failure. */
export function runRuntime(spawn: RuntimeSpawn, args: readonly string[]): RuntimeResult {
  const res = spawnSync(spawn.bin, [...args], {
    cwd: spawn.cwd,
    env: spawn.env ?? process.env,
    encoding: "utf8",
    timeout: spawn.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${spawn.bin} is not installed or not on PATH`);
    if (code === "ETIMEDOUT") throw new Error(`${spawn.bin} ${args[0] ?? ""} timed out`);
    throw res.error;
  }
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function failed(what: string, res: RuntimeResult): Error {
  const detail = (res.stderr || res.stdout).trim().split("\n").pop() ?? "";
  return new Error(`${what} failed (exit ${res.code ?? "unknown"})${detail ? `: ${detail}` : ""}`);
}

// --- Libraries -------------------------------------------------------------

/** `pi list` from the agent root (so project rows show) or the cwd. `--approve`
 * trusts the agent repo's own settings for this one read; a headless caller
 * cannot answer pi's trust prompt. */
export function piLibrary(spawn: RuntimeSpawn, agentRoot: string | null): ExtensionRow[] {
  const args = agentRoot ? [...PI_LIST_ARGS, "--approve"] : [...PI_LIST_ARGS];
  const res = runRuntime({ ...spawn, cwd: agentRoot ?? spawn.cwd }, args);
  if (res.code !== 0) throw failed("pi list", res);
  return parsePiList(res.stdout, agentRoot);
}

export function claudeLibrary(
  spawn: RuntimeSpawn,
  agentRoot: string | null,
): { installed: ExtensionRow[]; available: AvailableExtension[] } {
  const res = runRuntime({ ...spawn, cwd: agentRoot ?? spawn.cwd }, CLAUDE_LIST_ARGS);
  if (res.code !== 0) throw failed("claude plugin list", res);
  return parseClaudePluginList(res.stdout, agentRoot);
}

export function codexLibrary(spawn: RuntimeSpawn): { installed: ExtensionRow[]; available: AvailableExtension[] } {
  const res = runRuntime(spawn, CODEX_LIST_ARGS);
  if (res.code !== 0) throw failed("codex plugin list", res);
  return parseCodexPluginList(res.stdout);
}

// --- Launch sets -----------------------------------------------------------

export interface PiLaunchInput {
  spawn: RuntimeSpawn;
  /** The POV root — where `.pi/settings.json` declares and where `pi` runs. */
  agentRoot: string;
  /** The bundled extension dirs the turn already loads (`--ext`). */
  bundledPaths: string[];
  /** `--extensions "+a,-b"` from the conversation, raw. */
  overrides?: string;
}

export interface PiLaunchSet {
  /** Extra `--extension` paths, after the bundled ones. */
  extensionPaths: string[];
  /** Their `skills/` dirs, for `--skill`. */
  skillPaths: string[];
  /** What was asked for and not loaded, with why. */
  refused: Refusal[];
  /** Sources loaded, for the log line. */
  loaded: string[];
}

const NONE: PiLaunchSet = { extensionPaths: [], skillPaths: [], refused: [], loaded: [] };

/**
 * From the agent repo's declaration and the conversation's overrides to paths.
 * When nothing declares and nothing overrides this touches no binary at all —
 * today's turn is unchanged. An approved declaration that is not installed yet
 * is installed into the agent repo's project scope first (pi's own behavior on
 * trust); a conversation addition must already be in the library.
 */
export function piLaunchSet(input: PiLaunchInput): PiLaunchSet {
  const declared = readPiAgentDeclarations(input.agentRoot);
  const overrides = parseLaunchOverrides(input.overrides);
  if (!declared.length && !overrides.add.length && !overrides.remove.length) return NONE;

  const approvals = readApprovals();
  const bundledNames = new Set(input.bundledPaths.map(piPackageName));
  const resolved = resolveLaunch({
    bundled: [],
    declared,
    approved: (source) => isApproved(approvals, "pi", input.agentRoot, source),
    overrides,
  });
  const refused = [...resolved.refused];
  if (!resolved.loaded.length) return { ...NONE, refused };

  let rows = piLibrary(input.spawn, input.agentRoot);
  const declaredSet = new Set(declared);
  const missingDeclared = resolved.loaded.filter((s) => declaredSet.has(s) && !findRow(rows, s));
  if (missingDeclared.length) {
    for (const source of missingDeclared) {
      const res = runRuntime({ ...input.spawn, cwd: input.agentRoot, timeoutMs: 180_000 }, piInstallArgs(source, "agent"));
      if (res.code !== 0) throw failed(`pi install ${source}`, res);
    }
    rows = piLibrary(input.spawn, input.agentRoot);
  }

  const extensionPaths: string[] = [];
  const skillPaths: string[] = [];
  const loaded: string[] = [];
  for (const source of resolved.loaded) {
    const row = findRow(rows, source);
    if (!row?.installPath) {
      refused.push({ source, reason: "not-installed" });
      continue;
    }
    // The same extension reached by two sources (a library checkout of a
    // bundled one) would hard-error in pi on duplicate tool names — load once.
    if (bundledNames.has(piPackageName(row.installPath))) continue;
    extensionPaths.push(row.installPath);
    const skills = piPackageSkillsDir(row.installPath);
    if (skills) skillPaths.push(skills);
    loaded.push(source);
  }
  return { extensionPaths, skillPaths, refused, loaded };
}

/** Agent-scope row first (the declaration's own install), then the library. */
function findRow(rows: ExtensionRow[], source: string): ExtensionRow | undefined {
  return rows.find((r) => r.source === source && r.scope === "agent") ?? rows.find((r) => r.source === source);
}

/** The IdeaSpaces connector for Claude Code — the analogue of the bundled
 * pi-is-space. Always loaded when installed; a declaration cannot drop it. */
export const CLAUDE_CORE_PLUGIN = "ideaspaces@ideaspaces-xyz";

export interface ClaudeLaunchInput {
  spawn: RuntimeSpawn;
  agentRoot: string;
  overrides?: string;
}

export interface ClaudeLaunchSet {
  /** The `--settings` JSON, or null when the turn should pass nothing (today's behavior). */
  settings: string | null;
  refused: Refusal[];
  loaded: string[];
}

export function claudeLaunchSet(input: ClaudeLaunchInput): ClaudeLaunchSet {
  const declared = readClaudeAgentDeclarations(input.agentRoot);
  const overrides = parseLaunchOverrides(input.overrides);
  if (!declared.length && !overrides.add.length && !overrides.remove.length) {
    return { settings: null, refused: [], loaded: [] };
  }

  const approvals = readApprovals();
  const resolved = resolveLaunch({
    bundled: [CLAUDE_CORE_PLUGIN],
    declared,
    approved: (source) => isApproved(approvals, "claude", input.agentRoot, source),
    overrides,
  });
  const refused = [...resolved.refused];

  let { installed } = claudeLibrary(input.spawn, input.agentRoot);
  const declaredSet = new Set(declared);
  const missingDeclared = resolved.loaded.filter((id) => declaredSet.has(id) && !installed.some((r) => r.id === id));
  if (missingDeclared.length) {
    for (const id of missingDeclared) {
      const res = runRuntime({ ...input.spawn, cwd: input.agentRoot, timeoutMs: 180_000 }, claudeInstallArgs(id, "agent"));
      if (res.code !== 0) throw failed(`claude plugin install ${id}`, res);
    }
    installed = claudeLibrary(input.spawn, input.agentRoot).installed;
  }

  const installedIds = installed.map((r) => r.id);
  const loaded: string[] = [];
  for (const id of resolved.loaded) {
    if (!installedIds.includes(id)) {
      refused.push({ source: id, reason: "not-installed" });
      continue;
    }
    loaded.push(id);
  }
  const core = installedIds.includes(CLAUDE_CORE_PLUGIN) ? [CLAUDE_CORE_PLUGIN] : [];
  return { settings: claudeLaunchSettings(installedIds, [...core, ...loaded]), refused, loaded };
}

/** One line per refusal, for the turn's stderr — names the fix. */
export function describeRefusals(refused: Refusal[], runtime: "pi" | "claude", agentRoot: string): string[] {
  return refused.map((r) =>
    r.reason === "unapproved"
      ? `Extension not loaded (needs approval): ${r.source} — run: ideaspaces extensions approve ${r.source} --runtime ${runtime} --agent ${agentRoot}`
      : `Extension not loaded (not installed): ${r.source} — run: ideaspaces extensions install ${r.source} --runtime ${runtime}`,
  );
}
