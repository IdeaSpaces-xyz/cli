import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const findCommand: CommandDef = {
  name: "find",
  description: "Filter notes by tag, type, entity, or directory",
  usage: "ideaspaces power find [--tag TAG] [--type TYPE] [--attached-to ENTITY] [--dir PATH] [--limit N]",
  examples: [
    "ideaspaces power find --tag architecture",
    "ideaspaces power find --type perspective",
    "ideaspaces power find --attached-to hostname:acme.com",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);
    const client = await initClient(global);

    const { data: r } = await client.listNodes({
      tag: flags.tag as string | undefined,
      node_type: flags.type as string | undefined,
      attached_to: flags["attached-to"] as string | undefined,
      contributed_by: flags["contributed-by"] as string | undefined,
      dir_path: flags.dir as string | undefined,
      origin: flags.origin as string | undefined,
      limit: flags.limit ? Number(flags.limit) : undefined,
      offset: flags.offset ? Number(flags.offset) : undefined,
      sort_by: flags["sort-by"] as "updated_at" | "created_at" | undefined,
      sort_order: flags["sort-order"] as "asc" | "desc" | undefined,
    });

    if (!r.nodes.length) {
      output.result(r, "No matching nodes.");
      return 0;
    }

    if (global.json) {
      output.result(r, "");
      return 0;
    }

    const lines = [`${r.total} node(s)${r.total > r.nodes.length ? ` (showing ${r.nodes.length})` : ""}:`, ""];
    for (const n of r.nodes) {
      const summary = n.summary ? ` — ${n.summary}` : "";
      lines.push(`  ${n.path}${summary}`);
      const meta: string[] = [];
      if (n.node_type && n.node_type !== "note") meta.push(n.node_type);
      if (n.attached_to?.length) meta.push(`attached: ${n.attached_to.join(", ")}`);
      if (n.tags?.length) meta.push(`tags: ${n.tags.join(", ")}`);
      if (meta.length) lines.push(`    [${meta.join(" | ")}]`);
    }

    output.result(r, lines.join("\n"));
    return 0;
  },
};
