import { createSession } from "@ideaspaces/sdk";
import { initClient } from "../client.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const awarenessCommand: CommandDef = {
  name: "awareness",
  description: "Print space orientation (for hooks and piping)",
  usage: "ideaspaces awareness",
  examples: [
    "ideaspaces awareness          # print to stdout",
    "ideaspaces awareness --json   # structured output",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const client = await initClient(global);
    const session = createSession(client);
    const block = await session.getAwarenessBlock();

    output.result({ awareness: block }, block || "");
    return 0;
  },
};
