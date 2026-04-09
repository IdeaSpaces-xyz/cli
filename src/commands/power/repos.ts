import { createClient, autoSelectRepo } from "@ideaspaces/sdk";
import { loadConfig } from "../../auth/credentials.js";
import { createOutput } from "../../output.js";
import { formatRepoList } from "../../client.js";
import type { CommandDef } from "../../types.js";

export const reposCommand: CommandDef = {
  name: "repos",
  description: "List available spaces",
  usage: "ideaspaces power repos",
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run: ideaspaces login");
      return 2;
    }

    const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });
    const { repos } = await autoSelectRepo(client);

    if (!repos.length) {
      output.result({ repos: [] }, "No spaces found.");
      return 0;
    }

    const data = repos.map((r) => ({ slug: r.slug, name: r.name, repo_id: r.repo_id, hostname: r.hostname, file_count: r.file_count, last_activity: r.last_activity }));
    output.result({ repos: data }, formatRepoList(repos));
    return 0;
  },
};
