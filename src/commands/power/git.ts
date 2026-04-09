import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const gitCommand: CommandDef = {
  name: "git",
  description: "Temporal awareness — log, changes, diff, find",
  usage: "ideaspaces power git <op> [--path FILE] [--ref SHA] [--since SHA] [--limit N]",
  examples: [
    "ideaspaces power git log",
    "ideaspaces power git changes --since abc1234",
    "ideaspaces power git diff --ref abc1234",
    'ideaspaces power git find --text "authentication"',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const op = args[0] as "log" | "changes" | "find" | "diff" | "word_diff";
    if (!op) {
      output.error("Usage: ideaspaces power git <log|changes|diff|find|word_diff>");
      return 1;
    }

    const client = await initClient(global);
    const { data: r } = await client.gitOps({
      op,
      path: flags.path as string | undefined,
      ref: flags.ref as string | undefined,
      text: flags.text as string | undefined,
      since: flags.since as string | undefined,
      limit: flags.limit ? Number(flags.limit) : undefined,
    });

    if (global.json) {
      output.result(r, "");
      return 0;
    }

    const lines: string[] = [];
    if (r.entries?.length) {
      for (const e of r.entries) lines.push(`${e.sha.slice(0, 7)} ${e.date} ${e.author}: ${e.message}`);
    } else if (r.changes?.length) {
      for (const c of r.changes) lines.push(`${c.status} ${c.path}`);
    } else if (r.output) {
      lines.push(r.output.length > 3000 ? r.output.slice(0, 3000) + "\n... (truncated)" : r.output);
    }
    output.result(r, lines.length ? lines.join("\n") : "No results.");
    return 0;
  },
};
