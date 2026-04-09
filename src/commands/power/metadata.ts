import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const metadataCommand: CommandDef = {
  name: "metadata",
  description: "Update tags, entities, or accessibility on a node",
  usage: "ideaspaces power metadata <node-id> [--tags a,b] [--attached-to x,y]",
  examples: [
    'ideaspaces power metadata n_abc123 --tags "architecture,decision"',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const nodeId = args[0];
    if (!nodeId) {
      output.error("Usage: ideaspaces power metadata <node-id> [--tags a,b]");
      return 1;
    }

    const fields: Record<string, unknown> = {};
    if (flags.tags) fields.tags = (flags.tags as string).split(",").map((t) => t.trim());
    if (flags["attached-to"]) fields.attached_to = (flags["attached-to"] as string).split(",").map((t) => t.trim());
    if (flags.accessibility) fields.accessibility = (flags.accessibility as string).split(",").map((t) => t.trim());
    if (flags.references) fields.references = (flags.references as string).split(",").map((t) => t.trim());

    if (!Object.keys(fields).length) {
      output.error("Provide at least one field: --tags, --attached-to, --accessibility, --references");
      return 1;
    }

    const client = await initClient(global);
    const { data: r } = await client.updateMetadata(nodeId, fields);

    output.result(r, `Updated ${r.updated}: ${r.fields.join(", ")}`);
    return 0;
  },
};
