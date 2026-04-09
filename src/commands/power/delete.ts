import { createInterface } from "node:readline";
import { initClient } from "../../client.js";
import { createOutput } from "../../output.js";
import { setLastSha } from "../../auth/session-state.js";
import type { CommandDef } from "../../types.js";

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // Non-interactive: auto-confirm
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

export const deleteCommand: CommandDef = {
  name: "delete",
  description: "Delete a file (recoverable via git)",
  usage: "ideaspaces power delete <path> [--yes]",
  async run(args, _flags, global) {
    const output = createOutput(global);
    const path = args[0];
    if (!path) {
      output.error("Usage: ideaspaces power delete <path>");
      return 1;
    }

    const client = await initClient(global);
    const { data: file } = await client.readFile(path);
    if (!file.node_id) {
      output.error(`No node found at ${path}`);
      return 4;
    }

    if (!global.yes) {
      const ok = await confirm(`Delete ${path}?`);
      if (!ok) {
        output.log("Cancelled.");
        return 0;
      }
    }

    const { data: r } = await client.deleteNode(file.node_id);

    try {
      const { data: log } = await client.gitOps({ op: "log", limit: 1 });
      if (log.entries?.[0]?.sha) setLastSha(client.repoId, log.entries[0].sha);
    } catch { /* best effort */ }

    output.result(r, `Deleted: ${r.path}`);
    return 0;
  },
};
