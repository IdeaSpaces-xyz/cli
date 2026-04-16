import { createClient } from "@ideaspaces/sdk";
import { loadConfig, saveCredentials } from "../../auth/credentials.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const createCommand: CommandDef = {
  name: "create",
  description: "Create a new space",
  usage: "ideaspaces power create <name> [--slug SLUG] [--purpose PURPOSE]",
  examples: [
    "ideaspaces power create 'My Notes'",
    "ideaspaces power create 'Research' --purpose 'Track research findings'",
    "ideaspaces power create 'Team' --slug team-notes",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run: ideaspaces login");
      return 2;
    }

    const name = args[0]?.trim();
    if (!name) {
      output.error("Name required. Usage: ideaspaces power create <name>");
      return 1;
    }

    const slug = (flags.slug as string | undefined) || undefined;
    const purpose = (flags.purpose as string | undefined) || undefined;

    const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });

    const { data } = await client.createRepo({ name, slug, purpose });

    // Auto-connect to the new space
    if (!process.env.IS_API_KEY) {
      saveCredentials({
        api_url: config.apiUrl,
        api_key: config.apiKey,
        repo_id: data.repo_id,
      });
    }

    output.result(
      { repo_id: data.repo_id, slug: data.slug, name: data.name },
      `Created and connected: ${data.name} (${data.slug})`,
    );
    return 0;
  },
};
