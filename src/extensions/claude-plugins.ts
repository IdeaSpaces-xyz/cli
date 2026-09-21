/**
 * Claude Code plugins through the claude binary — `claude plugin …` with
 * `--json` where it exists (list, install, marketplace list). Nothing under
 * `~/.claude` is read for the library; the agent tier is the one file this
 * module reads directly, `.claude/settings.json` in the agent repo, because that
 * is the declaration itself (Claude Code reads the same file after project trust).
 *
 * Verified against Claude Code 2.1.278.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AvailableExtension, ExtensionMarketplace, ExtensionRow, ExtensionScope } from "./model.js";

export const CLAUDE_LIST_ARGS = ["plugin", "list", "--available", "--json"] as const;
export const CLAUDE_MARKETPLACE_LIST_ARGS = ["plugin", "marketplace", "list", "--json"] as const;

/** `--scope user|project` (Claude's `local` scope is a per-machine project
 * override; the agent tier is the shareable `project`). `-y` accepts a
 * marketplace-declared install command headlessly — the CLI shows the source it
 * is about to run in the approval step, so the answer was already given. */
export function claudeInstallArgs(pluginId: string, scope: ExtensionScope): string[] {
  return ["plugin", "install", pluginId, "--scope", scope === "agent" ? "project" : "user", "--json", "-y"];
}

export function claudeRemoveArgs(pluginId: string, scope: ExtensionScope): string[] {
  return ["plugin", "uninstall", pluginId, "--scope", scope === "agent" ? "project" : "user"];
}

export function claudeUpdateArgs(pluginId: string): string[] {
  return ["plugin", "update", pluginId];
}

export function claudeMarketplaceAddArgs(source: string, scope: ExtensionScope): string[] {
  return ["plugin", "marketplace", "add", source, "--scope", scope === "agent" ? "project" : "user"];
}

export function claudeMarketplaceRemoveArgs(name: string): string[] {
  return ["plugin", "marketplace", "remove", name];
}

interface ClaudeInstalledPlugin {
  id?: unknown;
  version?: unknown;
  scope?: unknown;
  enabled?: unknown;
  installPath?: unknown;
}

interface ClaudeAvailablePlugin {
  pluginId?: unknown;
  name?: unknown;
  description?: unknown;
  marketplaceName?: unknown;
}

/** Parse `claude plugin list --available --json` → `{installed, available}`.
 * Without `--available` Claude prints a bare array; both shapes are accepted.
 * Claude's `project`/`local` scopes both live in the agent repo → `agent`. */
export function parseClaudePluginList(
  stdout: string,
  agentRoot: string | null,
): { installed: ExtensionRow[]; available: AvailableExtension[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Could not parse `claude plugin list --json` output");
  }
  const installedRaw: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { installed?: unknown })?.installed)
      ? ((parsed as { installed: unknown[] }).installed)
      : [];
  const availableRaw: unknown[] = Array.isArray((parsed as { available?: unknown })?.available)
    ? ((parsed as { available: unknown[] }).available)
    : [];

  const installed: ExtensionRow[] = [];
  for (const entry of installedRaw as ClaudeInstalledPlugin[]) {
    if (!entry || typeof entry.id !== "string") continue;
    const scope: ExtensionScope = entry.scope === "project" || entry.scope === "local" ? "agent" : "user";
    installed.push({
      runtime: "claude",
      id: entry.id,
      source: claudeMarketplaceOf(entry.id),
      version: typeof entry.version === "string" ? entry.version : null,
      scope,
      enabled: entry.enabled !== false,
      installPath: typeof entry.installPath === "string" ? entry.installPath : null,
      declaredBy: scope === "agent" ? agentRoot : null,
    });
  }
  const available: AvailableExtension[] = [];
  for (const entry of availableRaw as ClaudeAvailablePlugin[]) {
    if (!entry || typeof entry.pluginId !== "string") continue;
    available.push({
      runtime: "claude",
      id: entry.pluginId,
      name: typeof entry.name === "string" ? entry.name : entry.pluginId,
      description: typeof entry.description === "string" ? entry.description : null,
      marketplace: typeof entry.marketplaceName === "string" ? entry.marketplaceName : claudeMarketplaceOf(entry.pluginId),
    });
  }
  return { installed, available };
}

/** `name@marketplace` → `marketplace`; a bare name has none. */
export function claudeMarketplaceOf(pluginId: string): string {
  const at = pluginId.indexOf("@");
  return at === -1 ? "" : pluginId.slice(at + 1);
}

interface ClaudeMarketplaceEntry {
  name?: unknown;
  source?: unknown;
  repo?: unknown;
  url?: unknown;
  path?: unknown;
}

/** Parse `claude plugin marketplace list --json`. The source is whichever of
 * `repo` (github), `url` (git), or `path` (local) the entry carries. */
export function parseClaudeMarketplaceList(stdout: string): ExtensionMarketplace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Could not parse `claude plugin marketplace list --json` output");
  }
  if (!Array.isArray(parsed)) return [];
  const out: ExtensionMarketplace[] = [];
  for (const entry of parsed as ClaudeMarketplaceEntry[]) {
    if (!entry || typeof entry.name !== "string") continue;
    const source = [entry.repo, entry.url, entry.path].find((v): v is string => typeof v === "string") ?? String(entry.source ?? "");
    out.push({ runtime: "claude", name: entry.name, source });
  }
  return out;
}

/** The plugins an agent repo's `.claude/settings.json` declares — the ids under
 * `enabledPlugins` set to true. Missing file → []; malformed JSON throws with
 * the path named. */
export function readClaudeAgentDeclarations(agentRoot: string): string[] {
  const file = join(agentRoot, ".claude", "settings.json");
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseClaudeEnabledPlugins(parsed);
}

export function parseClaudeEnabledPlugins(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const enabled = (settings as { enabledPlugins?: unknown }).enabledPlugins;
  if (!enabled || typeof enabled !== "object") return [];
  return Object.entries(enabled as Record<string, unknown>)
    .filter(([, on]) => on === true)
    .map(([id]) => id);
}

/**
 * The `--settings` JSON that makes a turn load exactly `loaded` — every
 * installed plugin named true or false, so nothing rides in from user or project
 * settings. Verified 2026-09-21 on 2.1.278: `--settings '{"enabledPlugins":…}'`
 * overrides per launch in both directions, and the init event's `plugins` list
 * confirms it. Builtins (`…@builtin`) are Claude's own and are left alone.
 */
export function claudeLaunchSettings(installedIds: string[], loaded: string[]): string {
  const want = new Set(loaded);
  const enabledPlugins: Record<string, boolean> = {};
  for (const id of installedIds) enabledPlugins[id] = want.has(id);
  for (const id of loaded) enabledPlugins[id] = true;
  return JSON.stringify({ enabledPlugins });
}
