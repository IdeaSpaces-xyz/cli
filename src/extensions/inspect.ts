/**
 * What an installed extension brings — read from its directory, no spawn. A pi
 * package declares a `pi` manifest in `package.json` (else pi's convention
 * dirs); a Claude/Codex plugin carries `.claude-plugin/plugin.json` and the
 * convention dirs of that standard. Counts, not contents: enough for a row's
 * detail view to say "14 skills, 1 MCP server" before a person enables it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionRuntime } from "./model.js";

export interface ExtensionInventory {
  runtime: ExtensionRuntime;
  name: string | null;
  description: string | null;
  version: string | null;
  components: Record<string, number>;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function countFiles(dir: string, match: (name: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter(match).length;
  } catch {
    return 0;
  }
}

/** Skills in the SKILL.md convention: `skills/<name>/SKILL.md`, plus top-level `.md`. */
function countSkills(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (existsSync(join(full, "SKILL.md"))) n++;
      } else if (entry.endsWith(".md")) n++;
    }
  } catch {
    return n;
  }
  return n;
}

/** Resolve a manifest entry list (pi: paths or globs relative to the root) to
 * a count of files it names; a directory counts its matching files. Globs are
 * counted as one entry — the exact set is pi's loader's business. */
function countPiEntries(root: string, entries: unknown, match: (name: string) => boolean): number {
  if (!Array.isArray(entries)) return 0;
  let n = 0;
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.startsWith("!")) continue;
    if (/[*?[]/.test(entry)) { n++; continue; }
    const full = join(root, entry);
    if (!existsSync(full)) continue;
    n += statSync(full).isDirectory() ? countFiles(full, match) : 1;
  }
  return n;
}

export function inspectExtension(runtime: ExtensionRuntime, installPath: string): ExtensionInventory {
  if (runtime === "pi") return inspectPiPackage(installPath);
  return inspectPlugin(runtime, installPath);
}

function inspectPiPackage(root: string): ExtensionInventory {
  const pkg = readJson(join(root, "package.json"));
  const manifest = pkg && typeof pkg.pi === "object" && pkg.pi ? (pkg.pi as Record<string, unknown>) : null;
  const code = (name: string) => /\.(ts|js)$/.test(name);
  const md = (name: string) => name.endsWith(".md");
  const json = (name: string) => name.endsWith(".json");
  const components = manifest
    ? {
        extensions: countPiEntries(root, manifest.extensions, code),
        skills: Array.isArray(manifest.skills)
          ? (manifest.skills as unknown[]).reduce<number>((n, e) => n + (typeof e === "string" ? countSkills(join(root, e)) : 0), 0)
          : 0,
        prompts: countPiEntries(root, manifest.prompts, md),
        themes: countPiEntries(root, manifest.themes, json),
      }
    : {
        extensions: countFiles(join(root, "extensions"), code),
        skills: countSkills(join(root, "skills")),
        prompts: countFiles(join(root, "prompts"), md),
        themes: countFiles(join(root, "themes"), json),
      };
  return {
    runtime: "pi",
    name: str(pkg?.name),
    description: str(pkg?.description),
    version: str(pkg?.version),
    components,
  };
}

function inspectPlugin(runtime: ExtensionRuntime, root: string): ExtensionInventory {
  const manifest = readJson(join(root, ".claude-plugin", "plugin.json")) ?? readJson(join(root, "plugin.json"));
  const md = (name: string) => name.endsWith(".md");
  const hooks = readJson(join(root, "hooks", "hooks.json"));
  const hookEvents = hooks && typeof hooks.hooks === "object" && hooks.hooks ? Object.keys(hooks.hooks as object).length : 0;
  const mcp = readJson(join(root, ".mcp.json"));
  const mcpServers = mcp && typeof mcp.mcpServers === "object" && mcp.mcpServers ? Object.keys(mcp.mcpServers as object).length : 0;
  return {
    runtime,
    name: str(manifest?.name),
    description: str(manifest?.description),
    version: str(manifest?.version),
    components: {
      skills: countSkills(join(root, "skills")),
      agents: countFiles(join(root, "agents"), md),
      commands: countFiles(join(root, "commands"), md),
      hooks: hookEvents,
      mcpServers,
    },
  };
}
