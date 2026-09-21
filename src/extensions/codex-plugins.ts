/**
 * Codex plugins through the codex binary — `codex plugin …` with `--json`.
 * Codex implements the same plugin standard as Claude Code (it reads
 * `.claude-plugin/marketplace.json` unchanged), so the rows line up; what
 * differs is that Codex has no `enable`/`disable` subcommand (enablement is the
 * `enabled` key under `[plugins."id"]` in `~/.codex/config.toml`, overridable per
 * launch with `-c 'plugins."id".enabled=false'`) and only a user scope: a
 * project-level `.codex/config.toml` was probed on 0.145.0 (2026-09-21) and did
 * not change `plugin list`, so there is no agent tier for Codex yet.
 *
 * Codex is not a local turn runtime in this CLI; this module covers the library
 * so a client can review and manage it in the same list.
 *
 * Verified against Codex 0.145.0.
 */

import type { AvailableExtension, ExtensionMarketplace, ExtensionRow } from "./model.js";

export const CODEX_LIST_ARGS = ["plugin", "list", "--json"] as const;
export const CODEX_MARKETPLACE_LIST_ARGS = ["plugin", "marketplace", "list", "--json"] as const;

export function codexInstallArgs(pluginId: string): string[] {
  return ["plugin", "add", pluginId, "--json"];
}

export function codexRemoveArgs(pluginId: string): string[] {
  return ["plugin", "remove", pluginId];
}

export function codexMarketplaceAddArgs(source: string): string[] {
  return ["plugin", "marketplace", "add", source];
}

export function codexMarketplaceRemoveArgs(name: string): string[] {
  return ["plugin", "marketplace", "remove", name];
}

/** `codex plugin marketplace upgrade` refreshes marketplace snapshots; plugins
 * follow their marketplace, so this is Codex's update. */
export function codexUpdateArgs(marketplace?: string): string[] {
  return marketplace ? ["plugin", "marketplace", "upgrade", marketplace] : ["plugin", "marketplace", "upgrade"];
}

/** A per-launch override: `-c plugins."<id>".enabled=<bool>`, one per id. */
export function codexLaunchOverrides(enabled: Record<string, boolean>): string[] {
  const args: string[] = [];
  for (const [id, on] of Object.entries(enabled)) args.push("-c", `plugins."${id}".enabled=${on ? "true" : "false"}`);
  return args;
}

interface CodexPlugin {
  pluginId?: unknown;
  name?: unknown;
  description?: unknown;
  marketplaceName?: unknown;
  version?: unknown;
  installed?: unknown;
  enabled?: unknown;
  source?: { source?: unknown; path?: unknown };
}

/** Parse `codex plugin list --json` → `{installed, available}`. Installed rows
 * carry their marketplace as the source; the on-disk path is
 * `source.path` when the plugin was materialised locally. */
export function parseCodexPluginList(stdout: string): { installed: ExtensionRow[]; available: AvailableExtension[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Could not parse `codex plugin list --json` output");
  }
  const pick = (key: "installed" | "available"): CodexPlugin[] => {
    const v = (parsed as Record<string, unknown> | null)?.[key];
    return Array.isArray(v) ? (v as CodexPlugin[]) : [];
  };
  const installed: ExtensionRow[] = [];
  for (const entry of pick("installed")) {
    if (!entry || typeof entry.pluginId !== "string") continue;
    installed.push({
      runtime: "codex",
      id: entry.pluginId,
      source: typeof entry.marketplaceName === "string" ? entry.marketplaceName : "",
      version: typeof entry.version === "string" ? entry.version : null,
      scope: "user",
      enabled: entry.enabled !== false,
      installPath: typeof entry.source?.path === "string" ? entry.source.path : null,
      declaredBy: null,
    });
  }
  const available: AvailableExtension[] = [];
  for (const entry of pick("available")) {
    if (!entry || typeof entry.pluginId !== "string") continue;
    available.push({
      runtime: "codex",
      id: entry.pluginId,
      name: typeof entry.name === "string" ? entry.name : entry.pluginId,
      description: typeof entry.description === "string" ? entry.description : null,
      marketplace: typeof entry.marketplaceName === "string" ? entry.marketplaceName : null,
    });
  }
  return { installed, available };
}

interface CodexMarketplace {
  name?: unknown;
  marketplaceSource?: { source?: unknown };
  root?: unknown;
}

/** Parse `codex plugin marketplace list --json` → `{marketplaces:[…]}`. */
export function parseCodexMarketplaceList(stdout: string): ExtensionMarketplace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Could not parse `codex plugin marketplace list --json` output");
  }
  const list = (parsed as { marketplaces?: unknown } | null)?.marketplaces;
  if (!Array.isArray(list)) return [];
  const out: ExtensionMarketplace[] = [];
  for (const entry of list as CodexMarketplace[]) {
    if (!entry || typeof entry.name !== "string") continue;
    const source = typeof entry.marketplaceSource?.source === "string"
      ? entry.marketplaceSource.source
      : typeof entry.root === "string" ? entry.root : "";
    out.push({ runtime: "codex", name: entry.name, source });
  }
  return out;
}
