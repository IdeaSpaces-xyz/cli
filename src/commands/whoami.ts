import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const whoamiCommand: CommandDef = {
  name: "whoami",
  description: "Show login state — whether credentials are present, and the API URL",
  usage: "ideaspaces whoami [--json]",
  examples: [
    "ideaspaces whoami",
    "ideaspaces whoami --json",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const config = loadConfig();

    if (!config) {
      output.result({ logged_in: false }, "Not logged in. Run `ideaspaces login`.");
      return 0;
    }

    // Never emit the API key — only whether we're logged in and where.
    output.result(
      { logged_in: true, api_url: config.apiUrl },
      `Logged in to ${config.apiUrl}.`,
    );
    return 0;
  },
};
