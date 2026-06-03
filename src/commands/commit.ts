/**
 * `ideaspaces commit -m "<message>" <path>...` — the explicit save.
 *
 * Capture is a deliberate two-beat for users: **commit** (save what you wrote)
 * then **sync** (push it out). Commit is the durable boundary, so it never
 * guesses scope:
 *
 *   - `commit -m "msg" <path>...`  — commit exactly these paths
 *   - `commit -m "msg" --tracked`  — commit paths the plugin staged this
 *                                    session (from SDK session state)
 *   - bare `commit -m "msg"`       — REFUSES; will not sweep all staged work
 *   - `commit -m "msg" --all`      — deferred (see issue); refuses for now
 *
 * Commits go through `commitPaths`, which uses explicit pathspecs — the user's
 * other staged work is never pulled into a capture commit.
 */

import { resolve } from "node:path";
import { sessionState } from "@ideaspaces/sdk";
import { commitPaths, repoRoot, stagedPaths, stagePaths, GitError } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const commitCommand: CommandDef = {
  name: "commit",
  description: "Save staged captures — commits only the paths you name",
  usage: 'ideaspaces commit -m "<message>" <path>... | --tracked | --all',
  examples: [
    'ideaspaces commit -m "Capture auth decision" notes/auth.md',
    'ideaspaces commit -m "Session captures" --tracked',
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

    // Exactly one path source: explicit args, --tracked, or --all.
    const sources = [args.length > 0, Boolean(flags.tracked), Boolean(flags.all)].filter(Boolean);
    if (sources.length > 1) {
      output.error("Use exactly one of: explicit <path>..., --tracked, or --all.");
      return 1;
    }

    // `store` set only for --tracked (reused for the post-commit clear below).
    const store = flags.tracked ? sessionState(root) : null;
    let paths: string[];
    let clearedPaths: string[] = [];

    if (flags.all) {
      // Commit all staged *ideaspace* paths (markdown + `_agent/`). Staged
      // non-knowledge files (code, configs) are left for the user to commit
      // themselves — this never sweeps up source changes.
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
    } else if (store) {
      paths = await store.getStagedPaths();
      if (!paths.length) {
        output.error("No plugin-tracked paths to commit (session state is empty).");
        return 1;
      }

      // Session state is advisory: it records paths the plugin staged, but it
      // can outlive the actual git diff when a capture was already committed
      // or otherwise cleaned up. Reconcile before committing so stale markers
      // don't block `sync` forever.
      try {
        stagePaths(paths, root);
      } catch (err) {
        if (err instanceof GitError) {
          output.error(`Staging tracked paths failed: ${err.message}`);
          return 1;
        }
        throw err;
      }

      const staged = new Set(stagedPaths(root));
      clearedPaths = paths.filter((p) => !staged.has(p));
      paths = paths.filter((p) => staged.has(p));

      await Promise.all(clearedPaths.map((p) => store.clearStagedPath(p)));

      if (!paths.length) {
        output.result(
          { commit_sha: null, committed_paths: [], cleared_paths: clearedPaths },
          `No tracked changes to commit; cleared ${clearedPaths.length} stale marker(s).`,
        );
        return 0;
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
          "or use --tracked / --all.",
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

    // Drop committed paths from the plugin's tracked set so they don't linger.
    if (store) {
      await Promise.all(paths.map((p) => store.clearStagedPath(p)));
    }

    output.result(
      store
        ? { commit_sha: sha, committed_paths: paths, cleared_paths: clearedPaths }
        : { commit_sha: sha, committed_paths: paths },
      `Committed ${paths.length} path(s): ${sha}`,
    );
    return 0;
  },
};

/** Knowledge path: a markdown file, or anything under an `_agent/` dir. */
function isIdeaspacePath(path: string): boolean {
  return path.endsWith(".md") || path.split("/").includes("_agent");
}
