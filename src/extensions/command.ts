/**
 * `ideaspaces extensions …` — one verb family over the local runtimes' own
 * package and plugin commands, with one row shape, so a client can show a
 * person what is installed, what an agent declares, what a marketplace offers,
 * and act on it — without ever touching `~/.pi`, `~/.claude`, or `~/.codex`
 * itself. Every write goes through the runtime's binary; the only file this
 * verb owns is the approval record.
 *
 *   list         the library (+ `--agent <root>` for that agent's declarations, `--available` for catalogs)
 *   install      into the library, or with `--scope agent --agent <root>` into the agent repo's declaration
 *   remove       the reverse
 *   update       one source, or everything the runtime manages
 *   inspect      what an installed extension brings (skills, tools, servers, …)
 *   marketplaces list / add <source> / remove <name>   (Claude Code, Codex)
 *   approve / revoke <source> --agent <root>            let an agent's declaration load in turns
 *
 * Binaries resolve like `pi-status` / `claude-status`: `--pi-bin`, `--claude-bin`,
 * `--codex-bin`, else the bare name from PATH.
 */

import { resolve as resolvePath } from "node:path";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";
import { approvalsPath, approve, isApproved, readApprovals, revoke, writeApprovals } from "./approvals.js";
import {
  CLAUDE_MARKETPLACE_LIST_ARGS,
  claudeInstallArgs,
  claudeMarketplaceAddArgs,
  claudeMarketplaceRemoveArgs,
  claudeRemoveArgs,
  claudeUpdateArgs,
  parseClaudeMarketplaceList,
  readClaudeAgentDeclarations,
} from "./claude-plugins.js";
import {
  CODEX_MARKETPLACE_LIST_ARGS,
  codexInstallArgs,
  codexMarketplaceAddArgs,
  codexMarketplaceRemoveArgs,
  codexRemoveArgs,
  codexUpdateArgs,
  parseCodexMarketplaceList,
} from "./codex-plugins.js";
import { inspectExtension, type ExtensionInventory } from "./inspect.js";
import {
  EXTENSION_RUNTIMES,
  isExtensionRuntime,
  type AvailableExtension,
  type ExtensionMarketplace,
  type ExtensionRow,
  type ExtensionRuntime,
  type ExtensionScope,
} from "./model.js";
import { piInstallArgs, piRemoveArgs, piUpdateArgs, readPiAgentDeclarations } from "./pi-packages.js";
import { claudeLibrary, codexLibrary, piLibrary, runRuntime, type RuntimeSpawn } from "./runtimes.js";

type Flags = Record<string, string | boolean>;

const USAGE =
  "ideaspaces extensions <list|install|remove|update|inspect|marketplaces|approve|revoke> [--runtime pi|claude|codex] [--agent <root>] [--scope user|agent] [--available] [--json]";

/** A declaration row: what the agent repo asks for, and where it stands. */
export interface DeclaredExtension {
  runtime: ExtensionRuntime;
  source: string;
  agentRoot: string;
  approved: boolean;
  installed: boolean;
  installPath: string | null;
}

export interface ExtensionsListing {
  rows: ExtensionRow[];
  declared: DeclaredExtension[];
  available?: AvailableExtension[];
}

function fail(output: Output, message: string): number {
  output.error(message);
  return 1;
}

function runtimesOf(flags: Flags, output: Output, dflt: ExtensionRuntime[] = [...EXTENSION_RUNTIMES]): ExtensionRuntime[] | null {
  const raw = flags.runtime;
  if (raw === undefined || raw === false || raw === "all") return dflt;
  if (typeof raw !== "string" || !isExtensionRuntime(raw)) {
    fail(output, `Unknown runtime "${String(raw)}". Valid values: ${EXTENSION_RUNTIMES.join(", ")}, all`);
    return null;
  }
  return [raw];
}

/** A write needs exactly one runtime. */
function oneRuntime(flags: Flags, output: Output): ExtensionRuntime | null {
  const raw = flags.runtime;
  if (typeof raw !== "string" || !isExtensionRuntime(raw)) {
    fail(output, `A runtime is required: --runtime ${EXTENSION_RUNTIMES.join("|")}`);
    return null;
  }
  return raw;
}

function agentRootOf(flags: Flags): string | null {
  return typeof flags.agent === "string" && flags.agent ? resolvePath(flags.agent) : null;
}

function scopeOf(flags: Flags, output: Output, agentRoot: string | null): ExtensionScope | null {
  const raw = flags.scope;
  const scope: ExtensionScope = raw === undefined || raw === false ? (agentRoot ? "agent" : "user") : (raw as ExtensionScope);
  if (scope !== "user" && scope !== "agent") {
    fail(output, `Unknown scope "${String(raw)}". Valid values: user, agent`);
    return null;
  }
  if (scope === "agent" && !agentRoot) {
    fail(output, "--scope agent needs --agent <root> (the agent repo the declaration lives in)");
    return null;
  }
  return scope;
}

function spawnFor(runtime: ExtensionRuntime, flags: Flags): RuntimeSpawn {
  const flag = flags[`${runtime}-bin`];
  return { bin: typeof flag === "string" && flag ? flag : runtime };
}

function library(runtime: ExtensionRuntime, spawn: RuntimeSpawn, agentRoot: string | null): {
  installed: ExtensionRow[];
  available: AvailableExtension[];
} {
  if (runtime === "pi") return { installed: piLibrary(spawn, agentRoot), available: [] };
  if (runtime === "claude") return claudeLibrary(spawn, agentRoot);
  return codexLibrary(spawn);
}

function declarations(runtime: ExtensionRuntime, agentRoot: string): string[] {
  if (runtime === "pi") return readPiAgentDeclarations(agentRoot);
  if (runtime === "claude") return readClaudeAgentDeclarations(agentRoot);
  return []; // Codex has no project-scope declaration (see codex-plugins.ts).
}

// --- list ------------------------------------------------------------------

async function cmdList(flags: Flags, output: Output): Promise<number> {
  const runtimes = runtimesOf(flags, output);
  if (!runtimes) return 1;
  const agentRoot = agentRootOf(flags);
  const wantAvailable = flags.available === true || flags.available === "true";
  const approvals = readApprovals();
  const listing: ExtensionsListing = { rows: [], declared: [] };
  if (wantAvailable) listing.available = [];
  const notes: string[] = [];

  for (const runtime of runtimes) {
    let installed: ExtensionRow[] = [];
    let available: AvailableExtension[] = [];
    try {
      ({ installed, available } = library(runtime, spawnFor(runtime, flags), agentRoot));
    } catch (err) {
      // A runtime that is not installed is not an error for the listing — the
      // row just is not there. Say so once, on stderr, and keep going.
      notes.push(`${runtime}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    listing.rows.push(...installed);
    if (listing.available) listing.available.push(...available);
    if (agentRoot) {
      let declared: string[];
      try {
        declared = declarations(runtime, agentRoot);
      } catch (err) {
        return fail(output, err instanceof Error ? err.message : String(err));
      }
      for (const source of declared) {
        const row = installed.find((r) => r.source === source || r.id === source);
        listing.declared.push({
          runtime,
          source,
          agentRoot,
          approved: isApproved(approvals, runtime, agentRoot, source),
          installed: !!row?.installPath,
          installPath: row?.installPath ?? null,
        });
      }
    }
  }
  for (const note of notes) output.log(note);
  output.result(listing, formatListing(listing));
  return 0;
}

function formatListing(l: ExtensionsListing): string {
  const out: string[] = [];
  if (!l.rows.length) out.push("No extensions installed.");
  for (const runtime of EXTENSION_RUNTIMES) {
    const rows = l.rows.filter((r) => r.runtime === runtime);
    if (!rows.length) continue;
    out.push(`${runtime}:`);
    for (const r of rows) {
      const bits = [r.version, r.scope === "agent" ? "agent" : null, r.enabled ? null : "disabled"].filter(Boolean);
      out.push(`  ${r.id}${bits.length ? ` (${bits.join(", ")})` : ""}`);
      if (r.installPath) out.push(`    ${r.installPath}`);
    }
  }
  if (l.declared.length) {
    out.push(`Declared by ${l.declared[0].agentRoot}:`);
    for (const d of l.declared) {
      const state = !d.approved ? "needs approval" : d.installed ? "ready" : "approved, not installed";
      out.push(`  ${d.runtime}  ${d.source}  — ${state}`);
    }
  }
  if (l.available) {
    out.push(`Available: ${l.available.length}`);
    for (const a of l.available.slice(0, 50)) out.push(`  ${a.runtime}  ${a.id}${a.description ? ` — ${a.description}` : ""}`);
    if (l.available.length > 50) out.push(`  … ${l.available.length - 50} more (use --json)`);
  }
  return out.join("\n");
}

// --- install / remove / update -------------------------------------------

/** The positional an action needs, or a one-line usage naming it. */
function sourceArg(args: string[], output: Output, what: string, usage: string): string | null {
  const source = args[0]?.trim();
  if (!source) {
    fail(output, `A ${what} is required: ${usage}`);
    return null;
  }
  return source;
}

async function cmdInstall(args: string[], flags: Flags, output: Output): Promise<number> {
  const runtime = oneRuntime(flags, output);
  if (!runtime) return 1;
  const source = sourceArg(args, output, "source", "ideaspaces extensions install <source> --runtime <r> [--scope agent --agent <root>]");
  if (!source) return 1;
  const agentRoot = agentRootOf(flags);
  const scope = scopeOf(flags, output, agentRoot);
  if (!scope) return 1;
  if (runtime === "codex" && scope === "agent") return fail(output, "Codex has no agent-scope declaration; install into the library (--scope user).");

  const spawn: RuntimeSpawn = { ...spawnFor(runtime, flags), cwd: scope === "agent" ? agentRoot! : undefined, timeoutMs: 180_000 };
  const argv = runtime === "pi" ? piInstallArgs(source, scope) : runtime === "claude" ? claudeInstallArgs(source, scope) : codexInstallArgs(source);
  output.progress(`${runtime} ${argv.join(" ")}`);
  try {
    const res = runRuntime(spawn, argv);
    if (res.code !== 0) return fail(output, (res.stderr || res.stdout).trim() || `${runtime} install failed (exit ${res.code ?? "unknown"})`);
  } catch (err) {
    return fail(output, err instanceof Error ? err.message : String(err));
  }
  // Installing into an agent repo's declaration is the person's own act — it
  // is approved by that act. A synced declaration someone else wrote is not.
  if (scope === "agent") writeApprovals(approve(readApprovals(), { runtime, agentRoot: agentRoot!, source }));
  const row = library(runtime, spawnFor(runtime, flags), agentRoot).installed.find((r) => r.source === source || r.id === source) ?? null;
  output.result({ runtime, source, scope, agentRoot, row }, `Installed ${source} (${runtime}, ${scope}${row?.installPath ? ` → ${row.installPath}` : ""})`);
  return 0;
}

async function cmdRemove(args: string[], flags: Flags, output: Output): Promise<number> {
  const runtime = oneRuntime(flags, output);
  if (!runtime) return 1;
  const source = sourceArg(args, output, "source", "ideaspaces extensions remove <source> --runtime <r> [--scope agent --agent <root>]");
  if (!source) return 1;
  const agentRoot = agentRootOf(flags);
  const scope = scopeOf(flags, output, agentRoot);
  if (!scope) return 1;
  const spawn: RuntimeSpawn = { ...spawnFor(runtime, flags), cwd: scope === "agent" ? agentRoot! : undefined };
  const argv = runtime === "pi" ? piRemoveArgs(source, scope) : runtime === "claude" ? claudeRemoveArgs(source, scope) : codexRemoveArgs(source);
  try {
    const res = runRuntime(spawn, argv);
    if (res.code !== 0) return fail(output, (res.stderr || res.stdout).trim() || `${runtime} remove failed (exit ${res.code ?? "unknown"})`);
  } catch (err) {
    return fail(output, err instanceof Error ? err.message : String(err));
  }
  if (scope === "agent") writeApprovals(revoke(readApprovals(), { runtime, agentRoot: agentRoot!, source }));
  output.result({ runtime, source, scope, agentRoot }, `Removed ${source} (${runtime}, ${scope})`);
  return 0;
}

async function cmdUpdate(args: string[], flags: Flags, output: Output): Promise<number> {
  const runtime = oneRuntime(flags, output);
  if (!runtime) return 1;
  const source = args[0]?.trim() || undefined;
  const argv = runtime === "pi" ? piUpdateArgs(source) : runtime === "claude" ? (source ? claudeUpdateArgs(source) : null) : codexUpdateArgs(source);
  if (!argv) return fail(output, "Claude Code updates one plugin at a time: ideaspaces extensions update <plugin@marketplace> --runtime claude");
  try {
    const res = runRuntime({ ...spawnFor(runtime, flags), timeoutMs: 180_000 }, argv);
    if (res.code !== 0) return fail(output, (res.stderr || res.stdout).trim() || `${runtime} update failed (exit ${res.code ?? "unknown"})`);
    output.result({ runtime, source: source ?? null, output: res.stdout.trim() }, res.stdout.trim() || `Updated (${runtime})`);
    return 0;
  } catch (err) {
    return fail(output, err instanceof Error ? err.message : String(err));
  }
}

// --- inspect ---------------------------------------------------------------

async function cmdInspect(args: string[], flags: Flags, output: Output): Promise<number> {
  const runtime = oneRuntime(flags, output);
  if (!runtime) return 1;
  const id = sourceArg(args, output, "id", "ideaspaces extensions inspect <id> --runtime <r>");
  if (!id) return 1;
  const agentRoot = agentRootOf(flags);
  let row: ExtensionRow | undefined;
  try {
    row = library(runtime, spawnFor(runtime, flags), agentRoot).installed.find((r) => r.id === id || r.source === id);
  } catch (err) {
    return fail(output, err instanceof Error ? err.message : String(err));
  }
  if (!row?.installPath) return fail(output, `${id} is not installed for ${runtime}${agentRoot ? ` (checked ${agentRoot} and the library)` : ""}`);
  const inventory: ExtensionInventory = inspectExtension(runtime, row.installPath);
  const parts = Object.entries(inventory.components).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
  output.result(
    { row, inventory },
    [
      `${inventory.name ?? row.id}${inventory.version ? ` ${inventory.version}` : ""}`,
      inventory.description ? `  ${inventory.description}` : null,
      `  Source: ${row.source}${row.scope === "agent" ? ` (agent: ${row.declaredBy})` : ""}`,
      `  Path: ${row.installPath}`,
      `  Brings: ${parts.length ? parts.join(", ") : "nothing detected"}`,
    ].filter(Boolean).join("\n"),
  );
  return 0;
}

// --- marketplaces ----------------------------------------------------------

async function cmdMarketplaces(args: string[], flags: Flags, output: Output): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const runtimes = runtimesOf(flags, output, ["claude", "codex"]);
    if (!runtimes) return 1;
    const marketplaces: ExtensionMarketplace[] = [];
    for (const runtime of runtimes) {
      if (runtime === "pi") continue; // pi has no marketplace concept — npm keyword only.
      try {
        const spawn = spawnFor(runtime, flags);
        const res = runRuntime(spawn, runtime === "claude" ? CLAUDE_MARKETPLACE_LIST_ARGS : CODEX_MARKETPLACE_LIST_ARGS);
        if (res.code !== 0) { output.log(`${runtime}: ${(res.stderr || res.stdout).trim()}`); continue; }
        marketplaces.push(...(runtime === "claude" ? parseClaudeMarketplaceList(res.stdout) : parseCodexMarketplaceList(res.stdout)));
      } catch (err) {
        output.log(`${runtime}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    output.result(
      { marketplaces },
      marketplaces.length ? marketplaces.map((m) => `${m.runtime}  ${m.name}  ${m.source}`).join("\n") : "No marketplaces configured.",
    );
    return 0;
  }
  const runtime = oneRuntime(flags, output);
  if (!runtime) return 1;
  if (runtime === "pi") return fail(output, "pi has no marketplaces; install pi packages by npm or git source.");
  if (sub === "add") {
    const source = sourceArg(args.slice(1), output, "marketplace source", "ideaspaces extensions marketplaces add <source> --runtime claude|codex");
    if (!source) return 1;
    const agentRoot = agentRootOf(flags);
    const scope = scopeOf(flags, output, agentRoot);
    if (!scope) return 1;
    const argv = runtime === "claude" ? claudeMarketplaceAddArgs(source, scope) : codexMarketplaceAddArgs(source);
    try {
      const res = runRuntime({ ...spawnFor(runtime, flags), cwd: scope === "agent" ? agentRoot! : undefined, timeoutMs: 180_000 }, argv);
      if (res.code !== 0) return fail(output, (res.stderr || res.stdout).trim() || `${runtime} marketplace add failed`);
      output.result({ runtime, source, scope }, `Added marketplace ${source} (${runtime})`);
      return 0;
    } catch (err) {
      return fail(output, err instanceof Error ? err.message : String(err));
    }
  }
  if (sub === "remove") {
    const name = sourceArg(args.slice(1), output, "marketplace name", "ideaspaces extensions marketplaces remove <name> --runtime claude|codex");
    if (!name) return 1;
    const argv = runtime === "claude" ? claudeMarketplaceRemoveArgs(name) : codexMarketplaceRemoveArgs(name);
    try {
      const res = runRuntime(spawnFor(runtime, flags), argv);
      if (res.code !== 0) return fail(output, (res.stderr || res.stdout).trim() || `${runtime} marketplace remove failed`);
      output.result({ runtime, name }, `Removed marketplace ${name} (${runtime})`);
      return 0;
    } catch (err) {
      return fail(output, err instanceof Error ? err.message : String(err));
    }
  }
  return fail(output, "Usage: ideaspaces extensions marketplaces [list|add <source>|remove <name>] --runtime claude|codex");
}

// --- approve / revoke ------------------------------------------------------

async function cmdApprove(args: string[], flags: Flags, output: Output, on: boolean): Promise<number> {
  const runtime = oneRuntime(flags, output);
  if (!runtime) return 1;
  const source = sourceArg(args, output, "source", "ideaspaces extensions approve|revoke <source> --runtime <r> --agent <root>");
  if (!source) return 1;
  const agentRoot = agentRootOf(flags);
  if (!agentRoot) return fail(output, "--agent <root> is required: approvals are per agent repo");
  // Approve what the repo actually declares — an approval for a source that is
  // not there would silently pre-approve a future pull.
  let declared: string[];
  try {
    declared = declarations(runtime, agentRoot);
  } catch (err) {
    return fail(output, err instanceof Error ? err.message : String(err));
  }
  if (on && !declared.includes(source)) {
    return fail(output, `${agentRoot} does not declare ${source} for ${runtime}; nothing to approve.`);
  }
  const entry = { runtime, agentRoot, source };
  writeApprovals(on ? approve(readApprovals(), entry) : revoke(readApprovals(), entry));
  output.result(
    { ...entry, approved: on, file: approvalsPath() },
    on ? `Approved ${source} for ${agentRoot} (${runtime}). Turns bound to this agent will load it.` : `Revoked ${source} for ${agentRoot} (${runtime}).`,
  );
  return 0;
}

export const extensionsCommand: CommandDef = {
  name: "extensions",
  description: "List, install, inspect, and approve extensions for the local runtimes (pi packages, Claude Code and Codex plugins)",
  usage: USAGE,
  examples: [
    "ideaspaces extensions list --json",
    "ideaspaces extensions list --runtime claude --available --json   # installed + marketplace catalog",
    "ideaspaces extensions list --agent /agents/integrator --json      # + what that agent declares, with approval state",
    "ideaspaces extensions install npm:pi-web-access --runtime pi",
    "ideaspaces extensions install git:github.com/user/repo@v1 --runtime pi --scope agent --agent /agents/integrator",
    "ideaspaces extensions install ralph-loop@claude-plugins-official --runtime claude",
    "ideaspaces extensions inspect ideaspaces@ideaspaces-xyz --runtime claude",
    "ideaspaces extensions marketplaces add IdeaSpaces-xyz/claude-code-plugin --runtime codex",
    "ideaspaces extensions approve git:github.com/user/repo@v1 --runtime pi --agent /agents/integrator",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const sub = args[0];
    const rest = args.slice(1);
    switch (sub) {
      case "list": return cmdList(flags, output);
      case "install": return cmdInstall(rest, flags, output);
      case "remove": return cmdRemove(rest, flags, output);
      case "update": return cmdUpdate(rest, flags, output);
      case "inspect": return cmdInspect(rest, flags, output);
      case "marketplaces": return cmdMarketplaces(rest, flags, output);
      case "approve": return cmdApprove(rest, flags, output, true);
      case "revoke": return cmdApprove(rest, flags, output, false);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};
