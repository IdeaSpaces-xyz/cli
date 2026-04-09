import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const tagsCommand: CommandDef = {
  name: "tags",
  description: "List tags in use across the space",
  usage: "ideaspaces power tags [prefix]",
  async run(args, _flags, global) {
    const output = createOutput(global);
    const client = await initClient(global);
    const { data: r } = await client.listTags(args[0]);

    if (!r.tags?.length) {
      output.result(r, "No tags found.");
      return 0;
    }

    const lines = r.tags.map((t) => `  ${t.tag}  (${t.total})`);
    output.result(r, `${r.tags.length} tags:\n${lines.join("\n")}`);
    return 0;
  },
};
