import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import type { CommandDef } from "../../types.js";

export const grepCommand: CommandDef = {
  name: "grep",
  description: "Text search or section extraction",
  usage: "ideaspaces power grep <pattern> [--scope DIR] [--heading TITLE]",
  examples: [
    'ideaspaces power grep "authentication"',
    'ideaspaces power grep --heading "## Design" --scope core/',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const client = await initClient(global);
    const scope = flags.scope as string | undefined;

    if (flags.heading) {
      const { data: r } = await client.grepSections(flags.heading as string, scope);
      if (!r.sections?.length) {
        output.result(r, `No sections matching "${flags.heading}"`);
        return 0;
      }
      const parts = r.sections.map((s) => {
        let text = `${s.file}:\n${s.content}`;
        if (s.truncated) text += "\n[truncated]";
        return text;
      });
      output.result(r, `${r.section_count} section(s) with "${flags.heading}":\n\n${parts.join("\n\n")}`);
      return 0;
    }

    const pattern = args[0];
    if (!pattern) {
      output.error("Usage: ideaspaces power grep <pattern> or --heading <title>");
      return 1;
    }

    const { data: r } = await client.grep(pattern, scope);
    const lines = r.matches.map((m) => `${m.file}:${m.line_number}: ${m.content}`);
    output.result(r, lines.length ? lines.join("\n") : `No matches for "${pattern}"`);
    return 0;
  },
};
