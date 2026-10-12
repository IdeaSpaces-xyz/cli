import { nodeCommand, USAGE_HISTORY } from "./node.js";
import type { CommandDef } from "../types.js";

export const historyCommand: CommandDef = {
  name: "history",
  description: "Read version history of a note in a clone or hosted (alias of `node history`)",
  usage: USAGE_HISTORY,
  examples: [
    "ideaspaces history notes/a.md --json",
    "ideaspaces history repo_abc node_xyz --json",
  ],
  async run(args, flags, global) {
    return nodeCommand.run(["history", ...args], flags, global);
  },
};
