import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const outlineCommand: CommandDef = {
  name: "outline",
  description: "Full tree of the space",
  usage: "ideaspaces power outline",
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const client = await initClient(global);
    const { data: r } = await client.outline();

    if (global.json) {
      output.result(r, "");
      return 0;
    }

    const branches = r.items.filter((i) => i.type === "branch");
    const files = r.items.filter((i) => i.type !== "branch");
    const lines: string[] = [`${r.items.length} items in ${r.slug}:`, ""];

    if (branches.length) {
      lines.push("Directories:");
      for (const b of branches) {
        const summary = b.summary ? ` — ${b.summary}` : "";
        lines.push(`  ${b.path}/${summary}`);
      }
      lines.push("");
    }

    lines.push("Files:");
    for (const f of files) {
      const summary = f.summary ? ` — ${f.summary}` : "";
      lines.push(`  ${f.path}${summary}`);
    }

    output.result(r, lines.join("\n"));
    return 0;
  },
};
