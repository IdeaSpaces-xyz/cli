import { loadSpaces } from "../auth/spaces.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const clonesCommand: CommandDef = {
  name: "clones",
  description: "List local clones — which folders are bound to which spaces",
  usage: "ideaspaces clones [--json]",
  examples: [
    "ideaspaces clones",
    "ideaspaces clones --json",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);

    const clones = Object.entries(loadSpaces()).map(([path, record]) => ({
      path,
      repo_id: record.repo_id,
      slug: record.slug,
      namespace: record.namespace,
    }));

    output.result(
      { clones },
      clones.length
        ? clones.map((c) => `${c.namespace}/${c.slug}  ${c.path}`).join("\n")
        : "No local clones yet. `ideaspaces clone <space>` to make one.",
    );
    return 0;
  },
};
