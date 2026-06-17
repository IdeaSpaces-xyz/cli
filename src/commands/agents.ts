import { fetchAgents, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

// List the Agent Actors the caller can pick to run a conversation. User-scoped
// (`GET /api/v1/agents`) — the caller's own agents, or another context's with
// `--owner`. Backs the desktop/web new-conversation agent picker.
export const agentsCommand: CommandDef = {
  name: "agents",
  description: "List Agent Actors you can use to run a conversation",
  usage: "ideaspaces agents [--owner <person:user|hostname:domain>] [--json]",
  examples: [
    "ideaspaces agents",
    "ideaspaces agents --owner hostname:acme.com",
    "ideaspaces agents --json",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    const owner = typeof flags.owner === "string" ? flags.owner : undefined;
    let agents;
    try {
      agents = await fetchAgents(config, owner);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error("Session expired. Run `ideaspaces login`.");
        return 1;
      }
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    output.result(
      { agents },
      agents.length
        ? agents
            .map(
              (a) =>
                `${a.name}${a.is_default ? " (default)" : ""}${a.can_use ? "" : " — no access"} → ${a.node_id}`,
            )
            .join("\n")
        : "No agents.",
    );
    return 0;
  },
};
