/**
 * `ideaspaces commit -m "<message>" <path>...` — the explicit save.
 *
 * Capture is a deliberate two-beat for users: **commit** (save what you wrote)
 * then **sync** (push it out). Commit is the durable boundary, so it never
 * guesses scope:
 *
 *   - `commit -m "msg" <path>...`  — commit exactly these paths
 *   - `commit -m "msg" --all`      — commit all staged knowledge paths
 *                                    (markdown + `_agent/`); staged code is left
 *   - bare `commit -m "msg"`       — REFUSES; will not sweep all staged work
 *
 * Commits go through `commitPaths`, which uses explicit pathspecs — the user's
 * other staged work is never pulled into a capture commit. The staged set comes
 * straight from git; there is no separate session ledger of "what we captured".
 */

import { resolve } from "node:path";
import { commitPaths, repoRoot, stagedPaths, isIdeaspacePath, GitError } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const commitCommand: CommandDef = {
  name: "commit",
  description: "Save staged captures — commits only the paths you name",
  usage: 'ideaspaces commit -m "<message>" <path>... | --all',
  examples: [
    'ideaspaces commit -m "Capture auth decision" notes/auth.md',
    'ideaspaces commit -m "Save notes" --all   # all staged markdown / _agent/ paths',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const message = String(flags.m ?? flags.message ?? "").trim();
    if (!message) {
      output.error('A commit message is required: ideaspaces commit -m "<message>" <path>...');
      return 1;
    }

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Exactly one path source: explicit args or --all.
    if (args.length > 0 && flags.all) {
      output.error("Use exactly one of: explicit <path>..., or --all.");
      return 1;
    }

    let paths: string[];

    if (flags.all) {
      // Commit all staged *ideaspace* paths (markdown + `_agent/`). Staged
      // non-knowledge files (code, configs) are left for the user to commit
      // themselves — this never sweeps up source changes. The staged set is
      // git's index; we don't keep our own list.
      const staged = stagedPaths(root);
      if (!staged.length) {
        output.error("Nothing staged to commit.");
        return 1;
      }
      paths = staged.filter(isIdeaspacePath);
      const other = staged.filter((p) => !isIdeaspacePath(p));
      if (!paths.length) {
        output.error(
          "No staged ideaspace paths (markdown or _agent/). Staged non-knowledge files:\n" +
            other.map((p) => `  ${p}`).join("\n"),
        );
        return 1;
      }
      if (other.length) {
        output.log(`Leaving ${other.length} non-ideaspace staged path(s) for you to commit: ${other.join(", ")}`);
      }
    } else {
      // Explicit args, resolved against the invocation cwd so a bare filename
      // from a subdir still points at the right file.
      paths = args.map((p) => resolve(p));
    }

    if (!paths.length) {
      // The safety default: never guess. Bare `commit -m "msg"` lands here.
      output.error(
        'Refusing to commit with no paths. Name the paths to save:\n' +
          '  ideaspaces commit -m "<message>" <path>...\n' +
          "or use --all.",
      );
      return 1;
    }

    let sha: string;
    try {
      sha = commitPaths(message, paths, root);
    } catch (err) {
      if (err instanceof GitError) {
        output.error(`Commit failed: ${err.message}`);
        return 1;
      }
      throw err;
    }

    output.result(
      { commit_sha: sha, committed_paths: paths },
      `Committed ${paths.length} path(s): ${sha}`,
    );
    return 0;
  },
};
