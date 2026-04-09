import { initClient } from "../client.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const NODE_ID_RE = /^(\/?n\/)?n_[a-f0-9]{12}$/;

export const readCommand: CommandDef = {
  name: "read",
  description: "Read a note's content and metadata",
  usage: "ideaspaces read <path|node-id> [--offset N] [--limit N]",
  examples: [
    "ideaspaces read core/About.md",
    "ideaspaces read n_8bb8cd420696",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const path = args[0];
    if (!path) {
      output.error("Usage: ideaspaces read <path|node-id>");
      return 1;
    }

    const client = await initClient(global);
    const opts = flags.offset || flags.limit
      ? { offset: flags.offset ? Number(flags.offset) : undefined, limit: flags.limit ? Number(flags.limit) : undefined }
      : undefined;

    const isNodeId = NODE_ID_RE.test(path);
    let r;
    if (isNodeId) {
      const { data: nodeData } = await client.readNode(path.replace(/^\/n\//, ""));
      if (opts && nodeData.path) {
        const { data: windowed } = await client.readFile(nodeData.path, opts);
        r = windowed;
      } else {
        r = nodeData;
      }
    } else {
      const { data: fileData } = await client.readFile(path, opts);
      r = fileData;
    }

    if (global.json) {
      output.result(r, "");
      return 0;
    }

    const meta: string[] = [];
    if (r.node_id) meta.push(`Node: /n/${r.node_id}`);
    if (r.tags?.length) meta.push(`Tags: ${r.tags.join(", ")}`);
    if (r.attached_to?.length) meta.push(`Attached to: ${r.attached_to.join(", ")}`);
    if (r.last_commit_sha) meta.push(`SHA: ${r.last_commit_sha}`);

    let text = meta.length ? meta.join("\n") + "\n\n" : "";
    text += r.content;
    if (r.continuation) {
      text += `\n\n[${r.continuation.remaining} more lines. Use --offset=${r.continuation.next_offset} to continue.]`;
    }

    output.result(r, text);
    return 0;
  },
};
