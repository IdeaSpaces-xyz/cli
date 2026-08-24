/**
 * `ideaspaces status` — where the capture stands.
 *
 * Surfaces the working-tree git position (protocol `gitState`) plus the staged
 * knowledge paths (markdown + `_agent/`) read straight from git's index, shown
 * separately so the user sees what's awaiting the explicit `commit` save.
 */

import { gitState, pathRevision } from "@ideaspaces/protocol";
import { stagedIdeaspacePaths, fetch as gitFetch } from "../git.js";
import {
  canonicalRepoRoot,
  localEffectCapabilities,
  toPortableRepoPath,
} from "../local-effects-adapter.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const statusCommand: CommandDef = {
  name: "status",
  description: "Show git position and plugin-tracked captures awaiting commit",
  usage: "ideaspaces status [--path FILE] [--fetch] [--json]",
  examples: [
    "ideaspaces status",
    "ideaspaces status --json",
    "ideaspaces status --fetch  # fetch first, so ahead/behind reflect the remote",
    "ideaspaces status --fetch --path notes/a.md",
    "ideaspaces status --path notes/a.md  # single-file state + sha (if_match source)",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);

    let root: string;
    try {
      root = canonicalRepoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Single-path mode: the sha here is what the caller passes as if_match to
    // safely update a file it didn't just write.
    const pathArg = typeof flags.path === "string" ? flags.path : undefined;
    if (pathArg) {
      const portablePath = toPortableRepoPath(pathArg, root);
      if (!portablePath) {
        output.error(`Path is outside the repository root: ${pathArg}`);
        return 1;
      }
      const read = await pathRevision(
        root,
        portablePath,
        localEffectCapabilities.git,
        localEffectCapabilities.filesystem,
      );
      if (read.status === "error") {
        if (global.json) output.result(read, "");
        else output.error(`${read.message}${read.path ? ` (${read.path})` : ""}`);
        return 1;
      }
      const revision = read.revision;
      const exists = revision.worktree !== null;
      const inIndex = revision.index !== revision.head;
      const modified = revision.worktree !== revision.index;
      const inTracked = revision.index !== null;
      output.result(
        {
          path: pathArg,
          exists,
          sha: revision.worktree,
          in_index: inIndex,
          modified,
          in_tracked: inTracked,
          revision,
        },
        exists
          ? `${pathArg}: sha ${revision.worktree}${inIndex ? ", staged" : ""}${modified ? ", modified" : ""}${inTracked ? "" : ", untracked"}`
          : `${pathArg}: does not exist`,
      );
      return 0;
    }

    // Read-only: fetch then report, never integrate (that's `pull`).
    if (flags.fetch) {
      try {
        gitFetch(root);
      } catch (err) {
        output.error(`git fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
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
