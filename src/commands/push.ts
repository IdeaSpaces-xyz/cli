/**
 * `ideaspaces push` — send committed captures to the remote.
 *
 * One direction across the agreement boundary: fetch → if **behind**, refuse
 * with "pull first" (the git-native rule surfaced as UX, not a merge surprise)
 * → push. Refuses up front if the plugin still has staged-but-uncommitted
 * captures — push moves committed history, so they'd be left behind silently.
 * Push does **not** require an otherwise-clean tree; unrelated dirt is fine.
 *
 *   (staged captures? refuse) → fetch → (behind? refuse: pull first) → push
 *
 * `--dry-run` reports the plan from existing remote-tracking state and mutates
 * nothing. Paired with `ideaspaces pull` — a single `sync` is deliberately gone
 * so the two directions stay legible.
 */

import {
  repoRoot,
  fetch,
  remoteState,
  push,
  stagedIdeaspacePaths,
  GitError,
} from "../git.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const pushCommand: CommandDef = {
  name: "push",
  description: "Send committed captures to the remote",
  usage: "ideaspaces push [--dry-run]",
  examples: ["ideaspaces push", "ideaspaces push --dry-run"],
  async run(_args, flags, global) {
    const output = createOutput(global);
    const dryRun = Boolean(flags["dry-run"]);

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Push moves committed history. Staged-but-uncommitted knowledge would be
    // left behind silently — refuse and point at the save step.
    const staged = stagedIdeaspacePaths(root);
    if (staged.length) {
      output.error(
        `Refusing to push: ${staged.length} staged capture(s) not yet committed.\n` +
          staged.map((p) => `  ${p}`).join("\n") +
          '\nSave them first: ideaspaces commit -m "<message>" --all',
      );
      return 1;
    }

    if (dryRun) {
      // Strictly non-mutating: report from existing remote-tracking state.
      const rs = remoteState(root);
      const plan: string[] = [];
      if (!rs.upstream) plan.push("no upstream configured — nothing to push");
      else {
        plan.push(`upstream: ${rs.upstream} (ahead ${rs.ahead}, behind ${rs.behind})`);
        if (rs.behind) plan.push(`would refuse: ${rs.behind} commit(s) behind — pull first`);
        else if (rs.ahead) plan.push(`would push ${rs.ahead} commit(s)`);
        else plan.push("up to date — nothing to push");
      }
      plan.push("(dry run — nothing fetched or pushed)");
      output.result({ dry_run: true, ...rs }, plan.join("\n"));
      return 0;
    }

    // Re-assert our credential helper before any network op — idempotent.
    await registerGitCredentialHelper();

    try {
      fetch(root);
      const rs = remoteState(root);
      if (!rs.upstream) {
        output.error("No upstream configured for the current branch.");
        return 1;
      }

      // The fundamental rule, surfaced: you can't push over remote work.
      if (rs.behind) {
        output.error(
          `Refusing to push: ${rs.behind} commit(s) behind ${rs.upstream}.\n` +
            "Pull first, then push: ideaspaces pull",
        );
        return 1;
      }

      if (!rs.ahead) {
        output.result(
          { upstream: rs.upstream, pushed: 0 },
          "Already up to date — nothing to push.",
        );
        return 0;
      }

      push(root);
      output.result(
        { upstream: rs.upstream, pushed: rs.ahead },
        `Pushed ${rs.ahead} commit(s) to ${rs.upstream}.`,
      );
      return 0;
    } catch (err) {
      if (err instanceof GitError) {
        output.error(`Push failed: ${err.message}`);
        return 1;
      }
      throw err;
    }
  },
};
