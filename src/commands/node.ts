import { fetchNode, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

// Resolve a node by id — name, path, content. Backs the desktop/web conversation
// workspace strip + preview (a conversation's `workspace` is bare node-ids).

async function cmdGet(args: string[], output: Output): Promise<number> {
  const [repoId, nodeId] = args;
  if (!repoId || !nodeId) {
    output.error("Usage: ideaspaces node get <repo_id> <node_id>");
    return 1;
  }

  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return 1;
  }

  try {
    const node = await fetchNode(config, repoId, nodeId);
    output.result(node, `${node.name_display || node.name}  (${node.path})`);
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

const USAGE = "Usage: ideaspaces node get <repo_id> <node_id>";

export const nodeCommand: CommandDef = {
  name: "node",
  description: "Resolve a node by id — name, path, content",
  usage: USAGE,
  examples: [
    "ideaspaces node get repo_abc node_xyz",
    "ideaspaces node get repo_abc node_xyz --json",
  ],
  async run(args, _flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    if (sub === "get") return cmdGet(rest, output);
    output.error(USAGE);
    return 1;
  },
};
