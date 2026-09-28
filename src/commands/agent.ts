import { parseFrontmatter } from "@ideaspaces/protocol";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listClones } from "../auth/spaces.js";
import { preferredContractSource } from "../contract-source.js";
import { loadMapNote } from "../local/map-note.js";
import { formatMapAgentsText, projectMapAgents } from "../local/map-agents.js";
import { createOutput, type Output } from "../output.js";
import type { LocalConversationOps } from "./conversation.js";
import {
  DEFAULT_LOCAL_RUNTIME,
  isLocalRuntime,
  LOCAL_RUNTIMES,
  type LocalRuntime,
} from "../local/runtime.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const RUN_USAGE =
  "ideaspaces agent run <pov> [--runtime pi|claude] [--model <name>] [--map <note>] [--conversation <id>] [--message <text>] [--json]";

export const LIST_USAGE =
  "ideaspaces agent list --map <file> [--json]";

export const USAGE =
  "ideaspaces agent <run|list> … (run <pov> [--runtime pi|claude] [--model <name>] [--map <note>] [--conversation <id>] [--message <text>] [--json]; list --map <file> [--json])";

/**
 * Resolve a point-of-view locator to an absolute directory path on the local machine.
 *
 * Checks:
 * 1. Direct path (relative or absolute folder).
 * 2. Registered local space by root_node_id (12-hex or 24-hex), repo_id, or slug.
 */
export function resolveAgentPov(pov: string): string | null {
  const trimmed = pov.trim();
  if (!trimmed) return null;

  // 1. Direct path check (relative to cwd or absolute)
  const candidatePath = resolve(process.cwd(), trimmed);
  if (existsSync(candidatePath)) {
    try {
      if (statSync(candidatePath).isDirectory()) {
        return candidatePath;
      }
    } catch {
      /* inaccessible path */
    }
  }

  // 2. Extract potential root node id (12-hex or 24-hex) or address
  let candidateId = trimmed;
  if (candidateId.startsWith("agent:repo:")) {
    candidateId = candidateId.slice("agent:repo:".length);
  } else if (candidateId.startsWith("knowledge:repo:")) {
    candidateId = candidateId.slice("knowledge:repo:".length);
  } else if (candidateId.startsWith("repo:")) {
    candidateId = candidateId.slice("repo:".length);
  } else if (candidateId.includes("/repos/")) {
    const match = /\/repos\/(n_(?:[0-9a-f]{24}|[0-9a-f]{12}))(?:\.git|\/|\?|#|$)/.exec(candidateId);
    if (match) candidateId = match[1];
  }

  // 3. Search local registered spaces
  const clones = listClones();
  const found = clones.find((c) => {
    if (c.record.root_node_id && c.record.root_node_id === candidateId) return true;
    if ("repo_id" in c.record && c.record.repo_id === candidateId) return true;
    if ("slug" in c.record && c.record.slug === candidateId) return true;
    return false;
  });

  if (found && existsSync(found.path)) {
    try {
      if (statSync(found.path).isDirectory()) {
        return found.path;
      }
    } catch {
      /* inaccessible path */
    }
  }

  return null;
}

export interface AgentDefaults {
  runtime?: LocalRuntime;
  model?: string;
}

/**
 * Read the default runtime and model declared in the POV's Agreement or Foundation frontmatter,
 * following standard CLI contract precedence via `preferredContractSource`.
 */
export function readAgentDefaults(povPath: string): AgentDefaults {
  const available = [
    ...(existsSync(join(povPath, "_agent", "agreement.md")) ? ["agreement" as const] : []),
    ...(existsSync(join(povPath, "_agent", "foundation.md")) ? ["foundation" as const] : []),
  ];
  const source = preferredContractSource(available);
  if (!source) return {};

  const contractPath = join(povPath, "_agent", `${source}.md`);

  try {
    const content = readFileSync(contractPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm || typeof fm !== "object") return {};

    const defaults: AgentDefaults = {};
    if (typeof fm.runtime === "string" && isLocalRuntime(fm.runtime.trim())) {
      defaults.runtime = fm.runtime.trim() as LocalRuntime;
    }
    if (typeof fm.model === "string" && fm.model.trim()) {
      defaults.model = fm.model.trim();
    } else if (defaults.runtime === "claude" && typeof fm.claude_model === "string" && fm.claude_model.trim()) {
      defaults.model = fm.claude_model.trim();
    } else if (defaults.runtime === "pi" && typeof fm.pi_model === "string" && fm.pi_model.trim()) {
      defaults.model = fm.pi_model.trim();
    }
    return defaults;
  } catch {
    return {};
  }
}

async function cmdRun(
  args: string[],
  flags: Flags,
  local: LocalConversationOps,
  output: Output,
): Promise<number> {
  const povArg = args[0];
  if (!povArg) {
    output.error(`Usage: ${RUN_USAGE}`);
    return 1;
  }

  const message = typeof flags.message === "string" ? flags.message : undefined;
  if (!message) {
    output.error("A message is required: --message <text>");
    return 1;
  }

  const povPath = resolveAgentPov(povArg);
  if (!povPath) {
    output.error(`Agent point of view "${povArg}" could not be resolved to a local directory or registered Space.`);
    return 1;
  }

  const defaults = readAgentDefaults(povPath);

  let runtime: LocalRuntime;
  if (flags.runtime !== undefined && flags.runtime !== false) {
    if (typeof flags.runtime !== "string" || !isLocalRuntime(flags.runtime)) {
      output.error(
        `Unknown local runtime "${String(flags.runtime)}". Valid values: ${LOCAL_RUNTIMES.join(", ")}`,
      );
      return 1;
    }
    runtime = flags.runtime;
  } else if (defaults.runtime) {
    runtime = defaults.runtime;
  } else {
    runtime = DEFAULT_LOCAL_RUNTIME;
  }

  let model: string | undefined;
  if (typeof flags.model === "string" && flags.model.trim()) {
    model = flags.model.trim();
  } else if (runtime === "pi" && typeof flags["pi-model"] === "string" && flags["pi-model"].trim()) {
    model = flags["pi-model"].trim();
  } else if (runtime === "claude" && typeof flags["claude-model"] === "string" && flags["claude-model"].trim()) {
    model = flags["claude-model"].trim();
  } else if (defaults.model) {
    model = defaults.model;
  }

  const forwardFlags: Flags = {
    ...flags,
    local: true,
    context: povPath,
    runtime,
    message,
  };

  if (model) {
    if (runtime === "pi") {
      forwardFlags["pi-model"] = model;
    } else if (runtime === "claude") {
      forwardFlags["claude-model"] = model;
    }
  }

  return local.send(forwardFlags, output);
}

function cmdList(
  flags: Flags,
  global: GlobalFlags,
  output: Output,
): number {
  const mapPath = flagString(flags, "map");
  if (!mapPath) {
    output.error(`--map <file> is required.\nUsage: ${LIST_USAGE}`);
    return 1;
  }

  const contextRoot = global.repo ? resolve(global.repo) : process.cwd();
  let loadedMap;
  try {
    loadedMap = loadMapNote(mapPath, contextRoot);
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const result = projectMapAgents(loadedMap, { cwd: contextRoot });
  const text = formatMapAgentsText(result);
  output.result(result, text);
  return 0;
}

export function makeAgentCommand(local: LocalConversationOps): CommandDef {
  return {
    name: "agent",
    description: "Run or list agents in a Space or point of view",
    usage: USAGE,
    examples: [
      "ideaspaces agent list --map home.map.md",
      "ideaspaces agent list --map home.map.md --json",
      "ideaspaces agent run agents/scout --runtime claude --model sonnet --message 'Check findings'",
      "ideaspaces agent run agents/scout --runtime pi --ext pi-is-space,pi-local-context --message 'Check findings'",
      "ideaspaces agent run agents/scout --conversation c_123 --message 'Resume turn'",
      "ideaspaces agent run n_0935a5df1f883eeb60bcdfbb --runtime claude --message 'Hello from root id'",
    ],
    async run(args, flags, global: GlobalFlags) {
      const output = createOutput(global);
      const [sub, ...rest] = args;
      switch (sub) {
        case "run":
          return cmdRun(rest, flags, local, output);
        case "list":
          return cmdList(flags, global, output);
        default:
          output.error(`Usage: ${USAGE}`);
          return 1;
      }
    },
  };
}
