/**
 * `ideaspaces status` — where the capture stands.
 *
 * Surfaces the working-tree git position (SDK `gitState`) plus the paths the
 * plugin staged this session (SDK `sessionState`), shown separately so the
 * user sees what's awaiting the explicit `commit` save.
 */

import { gitState, sessionState } from "@ideaspaces/sdk";
import { repoRoot, GitError } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const statusCommand: CommandDef = {
  name: "status",
  description: "Show git position and plugin-tracked captures awaiting commit",
  usage: "ideaspaces status [--json]",
  async run(_args, _flags, global) {
    const output = createOutput(global);

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const gs = await gitState(root);
    const tracked = await sessionState(root).getStagedPaths();

    const data = {
      repoRoot: gs.repoRoot,
      branch: gs.branch,
      ahead: gs.ahead,
      behind: gs.behind,
      dirty: gs.dirty,
      untracked_in_tracked_dirs: gs.untrackedInTrackedDirs,
      tracked_captures: tracked,
    };

    const lines: string[] = [];
    lines.push(`branch:  ${gs.branch ?? "(detached)"}`);
    if (gs.ahead != null || gs.behind != null) {
      lines.push(`remote:  ahead ${gs.ahead ?? 0}, behind ${gs.behind ?? 0}`);
    } else {
      lines.push("remote:  no upstream");
    }
    lines.push(`tree:    ${gs.dirty ? "dirty" : "clean"}`);
    if (tracked.length) {
      lines.push("", `captures awaiting commit (${tracked.length}):`);
      for (const p of tracked) lines.push(`  ${p}`);
      lines.push("", 'Save them: ideaspaces commit -m "<message>" --tracked');
    } else {
      lines.push("", "no plugin-tracked captures awaiting commit");
    }

    output.result(data, lines.join("\n"));
    return 0;
  },
};
