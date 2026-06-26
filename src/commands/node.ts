import { fetchNode, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

// Resolve a node by id — name, path, content. Backs the desktop/web conversation
// workspace strip + preview (a conversation's `workspace` is bare node-ids).

// Bare usage — `main.ts` adds the "Usage:" label for `--help`; error paths add
// it explicitly. Keeps `usage:` consistent with the other commands' fields.
const USAGE = "ideaspaces node get <repo_id> <node_id>";

async function cmdGet(args: string[], output: Output): Promise<number> {
  const [repoId, nodeId] = args;
  if (!repoId || !nodeId) {
    output.error(`Usage: ${USAGE}`);
    return 1;
  }

  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return 1;
  }

  try {
    const node = await fetchNode(config, repoId, nodeId);
    // Human mode gets a content preview too; the desktop drives `--json`.
    const preview = node.content.replace(/\s+/g, " ").trim();
    const snippet = preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
    const header = `${node.name_display || node.name} (${node.path})`;
    output.result(node, snippet ? `${header}\n${snippet}` : header);
    return 0;
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      output.error("Session expired. Run `ideaspaces login`.");
      return 1;
    }
    output.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export const nodeCommand: CommandDef = {
  name: "node",
  description: "Resolve a node by id — name, path, content (use --json for the full node)",
  usage: USAGE,
  examples: [
    "ideaspaces node get repo_abc node_xyz",
    "ideaspaces node get repo_abc node_xyz --json",
  ],
  async run(args, _flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    switch (sub) {
      case "get":
        return cmdGet(rest, output);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};
