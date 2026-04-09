import { loadConfig } from "../../auth/credentials.js";
import { getLastSha } from "../../auth/session-state.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const statusCommand: CommandDef = {
  name: "status",
  description: "Show connection info",
  usage: "ideaspaces power status",
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const config = loadConfig();

    if (!config) {
      output.result({ connected: false }, "Not logged in. Run: ideaspaces login");
      return 0;
    }

    const source = process.env.IS_API_KEY ? "env" : "credentials";
    const lastSha = config.repo ? getLastSha(config.repo) : undefined;

    const data = {
      connected: true,
      api_url: config.apiUrl,
      repo: config.repo || null,
      source,
      last_sha: lastSha || null,
    };

    const lines = [
      `API: ${config.apiUrl}`,
      `Repo: ${config.repo || "(not selected)"}`,
      `Source: ${source}`,
    ];
    if (lastSha) lines.push(`Last SHA: ${lastSha.slice(0, 7)}`);

    output.result(data, lines.join("\n"));
    return 0;
  },
};
