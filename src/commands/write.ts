import { SdkError } from "@ideaspaces/sdk";

import { initClient } from "../client.js";
import { createOutput } from "../output.js";
import { setLastSha } from "../auth/session-state.js";
import type { CommandDef } from "../types.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export const writeCommand: CommandDef = {
  name: "write",
  description: "Create or update a note",
  usage: "ideaspaces write <path> [--name NAME] [--summary TEXT] [--tags a,b] [--content TEXT] [--if-match SHA] [--force]",
  examples: [
    'echo "# My Note\\nContent here" | ideaspaces write notes/my-note.md --name "My Note"',
    'ideaspaces write notes/test.md --name "Test" --content "# Test\\nHello"',
    'ideaspaces write notes/test.md --content "# overwrite" --force',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const path = args[0];
    if (!path) {
      output.error("Usage: ideaspaces write <path> [--name NAME] [--summary TEXT]");
      return 1;
    }

    let content = flags.content as string | undefined;
    if (!content) {
      content = await readStdin();
      if (!content) {
        output.error("No content provided. Pipe content via stdin or use --content.");
        return 1;
      }
    }

    const client = await initClient(global);
    const tags = flags.tags ? (flags.tags as string).split(",").map((t) => t.trim()) : undefined;
    const attachedTo = flags["attached-to"]
      ? (flags["attached-to"] as string).split(",").map((t) => t.trim())
      : undefined;

    const force = Boolean(flags.force);
    const explicitIfMatch = flags["if-match"] as string | undefined;
    if (force && explicitIfMatch) {
      output.error("Use either --force or --if-match, not both.");
      return 1;
    }

    let ifMatch = explicitIfMatch;
    if (!ifMatch && !force) {
      try {
        const { data } = await client.readFile(path);
        ifMatch = data.last_commit_sha;
      } catch (error) {
        if (!(error instanceof SdkError && error.status === 404)) {
          throw error;
        }
      }
    }

    let r;
    try {
      ({ data: r } = await client.writeFile(path, {
        content,
        name: flags.name as string | undefined,
        summary: flags.summary as string | undefined,
        tags,
        attached_to: attachedTo,
        if_match: ifMatch,
      }));
    } catch (error) {
      if (error instanceof SdkError && error.status === 409) {
        output.error(
          "Write conflict: file changed since your last read. Re-run with --force to overwrite intentionally.",
        );
        return 5;
      }
      throw error;
    }

    // Track HEAD
    if (r.commit_sha) {
      try { setLastSha(client.repoId, r.commit_sha); } catch { /* best effort */ }
    }

    output.result(r, `Written: ${r.path}\nNode: /n/${r.node_id}\nCommit: ${r.commit_sha}`);
    return 0;
  },
};
