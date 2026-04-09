import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import { setLastSha } from "../../auth/session-state.js";
import type { CommandDef } from "../../types.js";

export const moveCommand: CommandDef = {
  name: "move",
  description: "Move or rename a file or directory",
  usage: "ideaspaces power move <source> <destination>",
  async run(args, _flags, global) {
    const output = createOutput(global);
    const source = args[0];
    const destination = args[1];
    if (!source || !destination) {
      output.error("Usage: ideaspaces power move <source> <destination>");
      return 1;
    }

    const client = await initClient(global);
    const { data: r } = await client.moveFile(source, destination);

    try {
      const { data: log } = await client.gitOps({ op: "log", limit: 1 });
      if (log.entries?.[0]?.sha) setLastSha(client.repoId, log.entries[0].sha);
    } catch { /* best effort */ }

    const text = r.files_updated != null
      ? `Moved directory: ${r.moved} → ${r.destination} (${r.files_updated} files)`
      : `Moved: ${r.moved} → ${r.destination}`;

    output.result(r, text);
    return 0;
  },
};
