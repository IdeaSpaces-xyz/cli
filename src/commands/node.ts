import { fetchNode, putFile, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

// Resolve / write a node by id or path. Backs the desktop/web conversation
// workspace strip + preview (a conversation's `workspace` is bare node-ids), and
// the preview's online edit (`put` → server file write, no clone needed).

// Bare usage — `main.ts` adds the "Usage:" label for `--help`; error paths add
// it explicitly. Keeps `usage:` consistent with the other commands' fields.
const USAGE = "ideaspaces node <get <repo_id> <node_id> | put <repo_id> <path> --content ...>";
const USAGE_GET = "ideaspaces node get <repo_id> <node_id>";
const USAGE_PUT = "ideaspaces node put <repo_id> <path> [--content TEXT]  (else reads stdin)";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function cmdGet(args: string[], output: Output): Promise<number> {
  const [repoId, nodeId] = args;
  if (!repoId || !nodeId) {
    output.error(`Usage: ${USAGE_GET}`);
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

// Write a note's content on the server (no clone needed) — the desktop's online
// edit path. Content from `--content` or stdin; empty is a valid (empty) note.
async function cmdPut(args: string[], flags: Flags, output: Output): Promise<number> {
  const [repoId, path] = args;
  if (!repoId || !path) {
    output.error(`Usage: ${USAGE_PUT}`);
    return 1;
  }
  const content = typeof flags.content === "string" ? flags.content : await readStdin();

  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return 1;
  }

  try {
    const res = await putFile(config, repoId, path, content);
    output.result(res, `Saved ${res.path}`);
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
  description: "Resolve (get) or write (put) a note — by id or path (use --json for the full node)",
  usage: USAGE,
  examples: [
    "ideaspaces node get repo_abc node_xyz --json",
    "ideaspaces node put repo_abc notes/a.md --content '# Hi'",
    "cat a.md | ideaspaces node put repo_abc notes/a.md --json",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    switch (sub) {
      case "get":
        return cmdGet(rest, output);
      case "put":
        return cmdPut(rest, flags, output);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};
