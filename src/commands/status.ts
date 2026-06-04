/**
 * `ideaspaces status` — where the capture stands.
 *
 * Surfaces the working-tree git position (SDK `gitState`) plus the staged
 * knowledge paths (markdown + `_agent/`) read straight from git's index, shown
 * separately so the user sees what's awaiting the explicit `commit` save.
 */

import { resolve } from "node:path";
import { gitState } from "@ideaspaces/sdk";
import { repoRoot, pathStatus, stagedIdeaspacePaths, GitError } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const statusCommand: CommandDef = {
  name: "status",
  description: "Show git position and plugin-tracked captures awaiting commit",
  usage: "ideaspaces status [--path FILE] [--json]",
  examples: [
    "ideaspaces status",
    "ideaspaces status --json",
    "ideaspaces status --path notes/a.md  # single-file state + sha (if_match source)",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Single-path mode: the sha here is what the caller passes as if_match to
    // safely update a file it didn't just write.
    const pathArg = typeof flags.path === "string" ? flags.path : undefined;
    if (pathArg) {
      // Resolve against the invocation cwd (the agent's dir), not the repo
      // root — an absolute path makes git's cwd irrelevant, so a bare filename
      // passed from a subdirectory still points at the right file.
      const ps = pathStatus(resolve(pathArg), root);
      // Report the path the caller passed (friendly), with git facts from the
      // resolved absolute path.
      output.result(
        {
          path: pathArg,
          exists: ps.exists,
          sha: ps.sha,
          in_index: ps.inIndex,
          modified: ps.modified,
          in_tracked: ps.inTracked,
        },
        ps.exists
          ? `${pathArg}: sha ${ps.sha}${ps.inIndex ? ", staged" : ""}${ps.modified ? ", modified" : ""}${ps.inTracked ? "" : ", untracked"}`
          : `${pathArg}: does not exist`,
      );
      return 0;
    }

    const gs = await gitState(root);
    const tracked = stagedIdeaspacePaths(root);

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
      lines.push("", 'Save them: ideaspaces commit -m "<message>" --all');
    } else {
      lines.push("", "no staged captures awaiting commit");
    }

    output.result(data, lines.join("\n"));
    return 0;
  },
};
