/**
 * `ideaspaces skills [<name>]` — the SDK skill catalog over the CLI.
 *
 * No args → list every skill (id + blurb). With a name → print that skill's
 * full markdown. This is how the MCP server serves skill resources without
 * taking a dependency on the SDK itself: it stays a thin CLI wrapper, and the
 * catalog logic lives here + in the SDK.
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

    if (name) {
      try {
        const skill = await readSkill(name);
        output.result(
          { name: skill.name, description: skill.description, content: skill.content },
          skill.content,
        );
        return 0;
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    const skills = await listSkills();
    output.result(
      skills,
      skills.map((s) => `${s.name}${s.description ? `  —  ${s.description}` : ""}`).join("\n"),
    );
    return 0;
  },
};
