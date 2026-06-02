/**
 * `ideaspaces skills [<name>]` — list the skill catalog, or print one skill's
 * markdown. The MCP server shells this so it needn't depend on the SDK itself.
 */

import { listSkills, readSkill } from "@ideaspaces/sdk";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const skillsCommand: CommandDef = {
  name: "skills",
  description: "List the skill catalog, or print one skill's markdown",
  usage: "ideaspaces skills [<name>]",
  examples: ["ideaspaces skills", "ideaspaces skills capture", "ideaspaces skills --json"],
  async run(args, _flags, global) {
    const output = createOutput(global);
    const name = args[0];
    try {
      if (name) {
        const skill = await readSkill(name);
        output.result(
          { name: skill.name, description: skill.description, content: skill.content },
          skill.content,
        );
      } else {
        const skills = await listSkills();
        output.result(
          skills,
          skills.map((s) => `${s.name}${s.description ? `  —  ${s.description}` : ""}`).join("\n"),
        );
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Named lookups that fail point back at the list.
      output.error(name ? `${msg}\nRun \`ideaspaces skills\` to list available skills.` : msg);
      return 1;
    }
  },
};
