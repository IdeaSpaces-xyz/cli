/**
 * `ideaspaces pull` — integrate remote changes into the local ideaspace.
 *
 * One direction across the agreement boundary: fetch → (if behind)
 * rebase|merge → done. It **never pushes**. Integrating requires a committed
 * tree — if the plugin has staged-but-uncommitted captures, or the tree is
 * otherwise dirty, it refuses rather than silently stashing (keep the capture
 * discipline visible; the user commits, we don't hide their work).
 *
 *   fetch → (if behind) rebase|merge, requiring a clean tree
 *
 * `--dry-run` reports the plan from existing remote-tracking state and mutates
 * nothing (no fetch, no network). Paired with `ideaspaces push` — a single
 * `sync` is deliberately gone so the two directions stay legible.
 */

import {
  repoRoot,
  fetch,
  remoteState,
  isDirty,
  rebaseOntoUpstream,
  mergeUpstream,
  stagedIdeaspacePaths,
  GitError,
} from "../git.js";
import { parseBool } from "../argv.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const pullCommand: CommandDef = {
  name: "pull",
  description: "Integrate remote changes into the local ideaspace",
  usage: "ideaspaces pull [--dry-run] [--rebase=false]",
  examples: ["ideaspaces pull", "ideaspaces pull --dry-run", "ideaspaces pull --rebase=false"],
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

    if (dryRun) {
      // Strictly non-mutating: report from existing remote-tracking state.
      const rs = remoteState(root);
      const plan: string[] = [];
      if (!rs.upstream) plan.push("no upstream configured — nothing to pull");
      else {
        plan.push(`upstream: ${rs.upstream} (ahead ${rs.ahead}, behind ${rs.behind})`);
        if (rs.behind) plan.push(`would ${useRebase ? "rebase onto" : "merge"} upstream (requires clean tree)`);
        else plan.push("up to date — nothing to integrate");
      }
      plan.push("(dry run — nothing fetched or integrated)");
      output.result({ dry_run: true, ...rs }, plan.join("\n"));
      return 0;
    }

    // Re-assert our credential helper before any network op — self-heals a
    // config written by an older CLI or a moved executable. Idempotent.
    await registerGitCredentialHelper();

    try {
      fetch(root);
      const rs = remoteState(root);
      if (!rs.upstream) {
        output.error("No upstream configured for the current branch.");
        return 1;
      }

      if (!rs.behind) {
        output.result(
          { upstream: rs.upstream, integrated: 0 },
          "Already up to date — nothing to pull.",
        );
        return 0;
      }

      // Integrating rewrites the working tree — require it clean and committed.
      // Staged captures get the capture-specific nudge; other dirt is generic.
      const staged = stagedIdeaspacePaths(root);
      if (staged.length) {
        output.error(
          `Refusing to pull: ${staged.length} staged capture(s) not yet committed.\n` +
            staged.map((p) => `  ${p}`).join("\n") +
            '\nSave them first: ideaspaces commit -m "<message>" --all',
        );
        return 1;
      }
      if (isDirty(root)) {
        output.error(
          "Refusing to integrate remote changes: working tree is dirty.\n" +
            "Commit your changes first, then re-run pull.",
        );
        return 1;
      }

      // A conflict here leaves git mid-rebase/merge — tell the user how to back out.
      try {
        if (useRebase) rebaseOntoUpstream(root);
        else mergeUpstream(root);
      } catch (err) {
        const msg = err instanceof GitError ? err.message : String(err);
        const reset = useRebase ? "git rebase --abort" : "git merge --abort";
        output.error(
          `Pull failed while integrating remote changes: ${msg}\n` +
            `The repo may be mid-${useRebase ? "rebase" : "merge"}. ` +
            `Run \`${reset}\` to reset, resolve the conflict, then re-run pull.`,
        );
        return 1;
      }

      output.result(
        { upstream: rs.upstream, integrated: rs.behind },
        `Pulled: integrated ${rs.behind} commit(s) from ${rs.upstream}.`,
      );
      return 0;
    } catch (err) {
      if (err instanceof GitError) {
        output.error(`Pull failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  },
};
