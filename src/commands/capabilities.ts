import { discover, installedCatalog } from "../agent-tools/catalog.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const capabilitiesCommand: CommandDef = {
  name: "capabilities",
  description: "Discover agent tool groups, a group's entries, or one full contract",
  usage: "ideaspaces capabilities [<group>|<id>] [--json]",
  help: "Start with groups and use_when. Select a group (for example threads or J4) for ids, does and use_when. Select an id (threads.post) for parameters, check, bound and output fields. This describes contracts, not host exposure or permissions. The full versioned catalog and JSON Schema ship in bundle/agent-tools.json and bundle/agent-tools.schema.json.",
  examples: ["ideaspaces capabilities --json", "ideaspaces capabilities threads --json", "ideaspaces capabilities threads.post --json"],
  async run(args, flags, global) {
    const output = createOutput(global);
    if (args.length > 1 || Object.keys(flags).length) { output.error("Usage: ideaspaces capabilities [<group>|<id>] [--json]"); return 1; }
    try {
      const result = discover(installedCatalog(), args[0]);
      const rows = result.groups ?? result.entries;
      const text = Array.isArray(rows) ? rows.map(row => `${row.id}${row.job ? ` (${row.job})` : ""} — ${row.does ? `${row.does} ` : ""}${row.use_when}`).join("\n") : JSON.stringify(result.entry, null, 2);
      output.result(result, text);
      return 0;
    } catch (error) { output.error(error instanceof Error ? error.message : String(error)); return 1; }
  },
};
