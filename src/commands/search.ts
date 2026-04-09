import { initClient } from "../client.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const searchCommand: CommandDef = {
  name: "search",
  description: "Find knowledge by meaning",
  usage: "ideaspaces search <query> [--scope DIR] [--type TYPE] [--limit N]",
  examples: [
    'ideaspaces search "authentication flow"',
    'ideaspaces search "pricing" --scope startups/',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const query = args[0];
    if (!query) {
      output.error("Usage: ideaspaces search <query>");
      return 1;
    }

    const client = await initClient(global);
    const { data } = await client.search({
      query,
      scope: flags.scope as string | undefined,
      node_type: flags.type as string | undefined,
      attached_to: flags["attached-to"] as string | undefined,
      contributed_by: flags["contributed-by"] as string | undefined,
      tags: flags.tags as string | undefined,
      limit: flags.limit ? Number(flags.limit) : undefined,
    });

    if (!data.results.length) {
      output.result({ results: [], query }, `No results for "${query}"`);
      return 0;
    }

    const lines = [`"${query}" (${data.results.length} results)`, ""];
    for (const r of data.results) {
      lines.push(`${r.score.toFixed(2)}  ${r.path}`);
      if (r.name) lines.push(`      ${r.name}`);
      if (r.summary) lines.push(`      ${r.summary}`);
    }

    output.result(data, lines.join("\n"));
    return 0;
  },
};
