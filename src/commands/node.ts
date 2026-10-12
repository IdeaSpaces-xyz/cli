import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fetchNode, fetchNodeHistory, putFile, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { getFileHistoryDetails, GitError, repoRoot } from "../git.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

// Resolve / write / history a note by id or path. Backs the desktop/web conversation
// workspace strip + preview (a conversation's `workspace` is bare node-ids),
// the preview's online edit (`put` → server file write, no clone needed), and
// note byline & version history (`history` → clone git log or hosted node history).

// Bare usage — `main.ts` adds the "Usage:" label for `--help`; error paths add
// it explicitly. Keeps `usage:` consistent with the other commands' fields.
const USAGE =
  "ideaspaces node <get <repo_id> <node_id> | put <repo_id> <path> --content ... | history <path> | history <repo_id> <node_id>>";
const USAGE_GET = "ideaspaces node get <repo_id> <node_id>";
const USAGE_PUT = "ideaspaces node put <repo_id> <path> [--content TEXT]  (else reads stdin)";
const USAGE_HISTORY =
  "ideaspaces node history <path>  (in a local clone)\nideaspaces node history <repo_id> <node_id>  (hosted)";

function toRepoRelativePath(repoRootPath: string, inputPath: string, cwd = process.cwd()): string {
  const realCwd = existsSync(cwd) ? realpathSync.native(cwd) : cwd;
  const absPath = resolve(realCwd, inputPath);
  const realAbsPath = existsSync(absPath) ? realpathSync.native(absPath) : absPath;
  const rel = relative(repoRootPath, realAbsPath);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    isAbsolute(rel)
  ) {
    throw new Error(`Path is outside repository: ${inputPath}`);
  }
  return rel.split(sep).join("/");
}

function formatHistoryHuman(data: {
  path: string;
  total: number;
  created: string | null;
  history: Array<{ sha: string; date: string; author: string; message: string; change_id?: string }>;
}): string {
  const countLabel =
    data.total > data.history.length
      ? `showing ${data.history.length} of ${data.total} commits`
      : `${data.total} commit${data.total === 1 ? "" : "s"}`;
  let human = `${data.path} (${countLabel}, created ${data.created ?? "uncommitted"})`;
  if (data.history.length > 0) {
    const lines = data.history.map((e) => {
      const shortSha = e.sha.slice(0, 8);
      const date = e.date.slice(0, 10);
      const change = e.change_id ? ` [${e.change_id}]` : "";
      return `  ${shortSha} ${date} ${e.author}: ${e.message}${change}`;
    });
    human += "\n" + lines.join("\n");
  }
  return human;
}

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

// Read a note's commit history in a local clone (`node history <path>`) or hosted (`node history <repo_id> <node_id>`).
async function cmdHistory(args: string[], flags: Flags, output: Output): Promise<number> {
  if (args.length === 1) {
    const [targetPath] = args;
    if (!targetPath) {
      output.error(`Usage: ${USAGE_HISTORY}`);
      return 1;
    }

    const probeDir = typeof flags.cwd === "string" ? resolve(process.cwd(), flags.cwd) : process.cwd();
    let root: string;
    try {
      root = repoRoot(probeDir);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    let relPath: string;
    try {
      relPath = toRepoRelativePath(root, targetPath, probeDir);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    try {
      const details = getFileHistoryDetails(relPath, { cwd: root, maxEntries: 20 });
      const fullPath = resolve(root, relPath);
      if (details.total === 0 && !existsSync(fullPath)) {
        output.error(`Note not found: ${targetPath}`);
        return 1;
      }

      const res = {
        path: relPath,
        created: details.created,
        total: details.total,
        history: details.entries,
      };

      output.result(res, formatHistoryHuman(res));
      return 0;
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (args.length === 2) {
    const [repoId, nodeId] = args;
    if (!repoId || !nodeId) {
      output.error(`Usage: ${USAGE_HISTORY}`);
      return 1;
    }
    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    try {
      const data = await fetchNodeHistory(config, repoId, nodeId);
      output.result(data, formatHistoryHuman(data));
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

  output.error(`Usage: ${USAGE_HISTORY}`);
  return 1;
}

export const nodeCommand: CommandDef = {
  name: "node",
  description: "Resolve (get), write (put), or view version history (history) of a note — by id or path (use --json for structured data)",
  usage: USAGE,
  examples: [
    "ideaspaces node get repo_abc node_xyz --json",
    "ideaspaces node put repo_abc notes/a.md --content '# Hi'",
    "cat a.md | ideaspaces node put repo_abc notes/a.md --json",
    "ideaspaces node history notes/a.md --json",
    "ideaspaces node history repo_abc node_xyz --json",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const [sub, ...rest] = args;
    switch (sub) {
      case "get":
        return cmdGet(rest, output);
      case "put":
        return cmdPut(rest, flags, output);
      case "history":
        return cmdHistory(rest, flags, output);
      default:
        output.error(`Usage: ${USAGE}`);
        return 1;
    }
  },
};
