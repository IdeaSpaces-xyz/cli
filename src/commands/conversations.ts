import { fetchConversations, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const conversationsCommand: CommandDef = {
  name: "conversations",
  description: "List a repo's conversations",
  usage: "ideaspaces conversations <repo_id> [--json]",
  examples: [
    "ideaspaces conversations repo_abc123",
    "ideaspaces conversations repo_abc123 --json",
  ],
  async run(args, _flags, global) {
    const output = createOutput(global);

    const repoId = args[0];
    if (!repoId) {
      output.error("Usage: ideaspaces conversations <repo_id>");
      return 1;
    }

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    let res;
    try {
      res = await fetchConversations(config, repoId);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error("Session expired. Run `ideaspaces login`.");
        return 1;
      }
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const { conversations, total } = res;
    // Results are capped at the request limit; `has_more` tells consumers the
    // list was truncated so `total` isn't read as "all of these are here".
    const has_more = total > conversations.length;

    output.result(
      { repo_id: repoId, conversations, total, has_more },
      conversations.length
        ? conversations
            .map((c) => `${c.name || "(untitled)"} — ${c.message_count} message${c.message_count === 1 ? "" : "s"}`)
            .join("\n") + (has_more ? `\n… and ${total - conversations.length} more` : "")
        : "No conversations.",
    );
    return 0;
  },
};
