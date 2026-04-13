import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

interface ReindexResult {
  repo_id: string;
  removed_entries: number;
  indexed_files: number;
  status: string;
}

export const reindexCommand: CommandDef = {
  name: "reindex",
  description: "Reindex the active space",
  usage: "ideaspaces power reindex [--repo <slug|repo_id>]",
  examples: [
    "ideaspaces power reindex",
    "ideaspaces --repo ideaspace power reindex",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const client = await initClient(global);

    const reindexRepo = (client as any).reindexRepo as
      | ((repoId?: string) => Promise<{ data: ReindexResult }>)
      | undefined;

    if (typeof reindexRepo !== "function") {
      output.error("SDK in this CLI build does not support reindexRepo(). Update @ideaspaces/sdk.");
      return 1;
    }

    const { data: result } = await reindexRepo(client.repoId);

    output.result(
      result,
      `Reindexed: ${result.repo_id}\nRemoved entries: ${result.removed_entries}\nIndexed files: ${result.indexed_files}`,
    );

    return 0;
  },
};
