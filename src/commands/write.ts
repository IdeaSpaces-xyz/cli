import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const writeCommand: CommandDef = {
  name: "write",
  description:
    "Create or update a Note with Layer 1 frontmatter (local — reframed in the build sweep)",
  usage: "ideaspaces write <path> [--name NAME] [--summary TEXT] [--tags a,b]",
  async run(_args, _flags, global) {
    const output = createOutput(global);
    output.error(
      "ideaspaces write is being reframed for local-first. The new flow writes to the filesystem with frontmatter via SDK utilities (forthcoming). Use native Write or the is_write MCP tool in the meantime.",
    );
    return 1;
  },
};
