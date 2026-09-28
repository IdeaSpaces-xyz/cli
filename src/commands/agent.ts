import { resolve } from "node:path";
import { loadMapNote } from "../local/map-note.js";
import { formatMapAgentsText, projectMapAgents } from "../local/map-agents.js";
import { createOutput } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const AGENT_USAGE =
  "ideaspaces agent list --map <file> [--json]";

export const agentCommand: CommandDef = {
  name: "agent",
  description: "List agent-kind roots in a Space Map",
  usage: AGENT_USAGE,
  examples: [
    "ideaspaces agent list --map home.map.md",
    "ideaspaces agent list --map home.map.md --json",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);

    const [sub] = args;
    if (sub !== undefined && sub !== "list") {
      output.error(`Usage: ${AGENT_USAGE}`);
      return 1;
    }

    const mapPath = flagString(flags, "map");
    if (!mapPath) {
      output.error(`--map <file> is required.\nUsage: ${AGENT_USAGE}`);
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
  },
};
