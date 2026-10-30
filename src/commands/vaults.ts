import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";
import { vaultsVerb } from "./hosted-threads.js";

export const vaultsCommand: CommandDef = {
  name: "vaults",
  description: "List your Vaults: your own, each organization's, and roots shared with you (GET /vaults)",
  usage: "ideaspaces vaults [--json]",
  examples: [
    "ideaspaces vaults",
    "ideaspaces vaults --json  # the service's answer unchanged: personal, orgs, shared_with_me",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const unknown = Object.keys(flags)[0];
    if (args.length || unknown) {
      output.error(unknown ? `Unknown flag for vaults: --${unknown}. Usage: ideaspaces vaults [--json]` : "Usage: ideaspaces vaults [--json]");
      return 1;
    }
    return vaultsVerb(output, global.json);
  },
};
