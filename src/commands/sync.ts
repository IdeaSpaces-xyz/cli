import { syncToSpace } from "@ideaspaces/sdk";
import { createInterface } from "node:readline";
import { autoSelectRepo, type RepoInfo } from "@ideaspaces/sdk";
import { initClient } from "../client.js";
import { createOutput } from "../output.js";
import { setLastSha } from "../auth/session-state.js";
import type { CommandDef } from "../types.js";

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
}

export const syncCommand: CommandDef = {
  name: "sync",
  description: "Sync a local directory to the space",
  usage: "ideaspaces sync <local-path> <space-path> [--dry-run]",
  examples: [
    "ideaspaces sync Docs/core/ core/",
    "ideaspaces sync Docs/core/ core/ --dry-run",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const localPath = args[0];
    const spacePath = args[1];

    if (!localPath || !spacePath) {
      output.error("Usage: ideaspaces sync <local-path> <space-path>");
      return 1;
    }

    const client = await initClient(global);
    const dryRun = !!flags["dry-run"];

    // Show destination and confirm before uploading
    if (!dryRun && !global.yes) {
      const repoId = client.repoId;
      let repoLabel = repoId;
      try {
        const { repos } = await autoSelectRepo(client);
        const match = repos.find((r: RepoInfo) => r.repo_id === repoId);
        if (match) {
          repoLabel = match.hostname
            ? `${match.hostname}/${match.slug} (${match.name || match.slug})`
            : `${match.slug} (personal)`;
        }
      } catch { /* best effort — fall back to repo_id */ }

      output.progress(`Destination: ${repoLabel}`);
      output.progress(`Space path:  ${spacePath}/`);
      output.progress(`Source:      ${localPath}`);
      const ok = await confirm("Proceed with sync?");
      if (!ok) {
        output.log("Cancelled.");
        return 0;
      }
    }

    if (dryRun) output.progress("Dry run — no files will be written.");

    const result = await syncToSpace(client, localPath, spacePath, {
      dryRun,
      onProgress: (msg) => output.progress(msg),
    });

    // Track HEAD
    if (result.newHead) {
      try { setLastSha(client.repoId, result.newHead); } catch { /* best effort */ }
    }

    if (global.json) {
      output.result(result, "");
    } else {
      const lines: string[] = [];
      if (result.uploaded.length) lines.push(`Uploaded: ${result.uploaded.length} files`);
      if (result.skipped.length) lines.push(`Skipped: ${result.skipped.length} unchanged`);
      if (result.conflicts.length) lines.push(`Conflicts: ${result.conflicts.join(", ")}`);
      if (result.errors.length) {
        lines.push("Errors:");
        for (const e of result.errors) lines.push(`  ${e.path}: ${e.error}`);
      }
      if (!lines.length) lines.push("Nothing to sync.");
      output.result(result, lines.join("\n"));
    }

    return result.errors.length ? 1 : 0;
  },
};
