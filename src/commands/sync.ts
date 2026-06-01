/**
 * `ideaspaces sync` — push captures out (and pull others' in).
 *
 * The second user-facing beat after the explicit `commit` save. Minimal and
 * safe by design: it integrates and pushes, but it does **not** try to stash
 * and replay the user's unrelated work. If the tree is dirty in a way that
 * blocks a rebase, it refuses with guidance rather than touching that work.
 *
 *   fetch → (if behind) rebase|merge, requiring a clean tree → push
 *
 * Refuses up front if the plugin still has uncommitted tracked captures — sync
 * pushes committed history, so save first. `--dry-run` reports the plan and
 * mutates nothing (no fetch, no network).
 */

import { sessionState } from "@ideaspaces/sdk";
import {
  repoRoot,
  fetch,
  remoteState,
  isDirty,
  rebaseOntoUpstream,
  mergeUpstream,
  push,
  GitError,
} from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

function parseBool(v: unknown, dflt: boolean): boolean {
  if (typeof v !== "string") return v === undefined ? dflt : Boolean(v);
  const s = v.trim().toLowerCase();
  return !(s === "false" || s === "0" || s === "no" || s === "off");
}

export const syncCommand: CommandDef = {
  name: "sync",
  description: "Integrate remote changes and push committed captures",
  usage: "ideaspaces sync [--dry-run] [--rebase=false]",
  examples: ["ideaspaces sync", "ideaspaces sync --dry-run", "ideaspaces sync --rebase=false"],
  async run(_args, flags, global) {
    const output = createOutput(global);
    const dryRun = Boolean(flags["dry-run"]);
    const useRebase = parseBool(flags.rebase, true);

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Sync pushes committed history. Uncommitted plugin captures would be left
    // behind silently — refuse and point at the save step.
    const tracked = await sessionState(root).getStagedPaths();
    if (tracked.length) {
      output.error(
        `Refusing to sync: ${tracked.length} plugin-tracked capture(s) not yet committed.\n` +
          tracked.map((p) => `  ${p}`).join("\n") +
          '\nSave them first: ideaspaces commit -m "<message>" --tracked',
      );
      return 1;
    }

    if (dryRun) {
      // Strictly non-mutating: report from existing remote-tracking state, no
      // fetch, no push.
      const rs = remoteState(root);
      const plan: string[] = [];
      if (!rs.upstream) plan.push("no upstream configured — nothing to sync");
      else {
        plan.push(`upstream: ${rs.upstream} (ahead ${rs.ahead}, behind ${rs.behind})`);
        if (rs.behind) plan.push(`would ${useRebase ? "rebase onto" : "merge"} upstream (requires clean tree)`);
        if (rs.ahead) plan.push(`would push ${rs.ahead} commit(s)`);
        if (!rs.ahead && !rs.behind) plan.push("up to date");
      }
      plan.push("(dry run — nothing fetched or pushed)");
      output.result({ dry_run: true, ...rs }, plan.join("\n"));
      return 0;
    }

    try {
      fetch(root);
      const rs = remoteState(root);
      if (!rs.upstream) {
        output.error("No upstream configured for the current branch.");
        return 1;
      }

      if (rs.behind) {
        if (isDirty(root)) {
          output.error(
            "Refusing to integrate remote changes: working tree is dirty.\n" +
              "Commit or stash your changes first, then re-run sync.",
          );
          return 1;
        }
        if (useRebase) rebaseOntoUpstream(root);
        else mergeUpstream(root);
      }

      const after = remoteState(root);
      if (after.ahead) push(root);

      output.result(
        { upstream: after.upstream, pushed: after.ahead, integrated: rs.behind },
        after.ahead || rs.behind
          ? `Synced: integrated ${rs.behind} commit(s), pushed ${after.ahead} commit(s).`
          : "Already up to date.",
      );
      return 0;
    } catch (err) {
      if (err instanceof GitError) {
        output.error(`Sync failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  },
};
