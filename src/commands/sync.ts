import { syncToSpace } from "@ideaspaces/sdk";
import { initClient } from "../client.js";
import { createOutput } from "../output.js";
import { setLastSha } from "../auth/session-state.js";
import type { CommandDef } from "../types.js";

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
