/**
 * `ideaspaces times` — per-note git created/updated times for the clone.
 *
 * Backs the desktop's note-list sort (by creation / update date). The dates come
 * from git history, not the filesystem: a clone's mtime/birthtime are all the
 * checkout moment, so they're useless for ordering. Run with the clone as cwd
 * (like `status`/`commit`/`sync`).
 */

import { repoRoot, fileTimes, GitError } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const timesCommand: CommandDef = {
  name: "times",
  description: "Per-note git created/updated times (first & last commit) for this clone",
  usage: "ideaspaces times [--json]",
  examples: ["ideaspaces times --json"],
  async run(_args, _flags, global) {
    const output = createOutput(global);

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof GitError ? err.message : err instanceof Error ? err.message : String(err));
      return 1;
    }

    const files = fileTimes(root);
    const human = files.length
      ? files
          .map((f) => `${new Date(f.updated_at).toISOString().slice(0, 10)}  ${f.path}`)
          .join("\n")
      : "no tracked notes";
    output.result({ files }, human);
    return 0;
  },
};
