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

import { sessionState } from "@ideaspaces/sdk";
import { commitPaths, repoRoot, GitError } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const commitCommand: CommandDef = {
  name: "commit",
  description: "Save staged captures — commits only the paths you name",
  usage: 'ideaspaces commit -m "<message>" <path>... | --tracked',
  examples: [
    'ideaspaces commit -m "Capture auth decision" notes/auth.md',
    'ideaspaces commit -m "Session captures" --tracked',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const message = String(flags.m ?? flags.message ?? "").trim();
    if (!message) {
      output.error('A commit message is required: ideaspaces commit -m "<message>" <path>...');
      return 1;
    }

    if (flags.all) {
      output.error(
        "commit --all is not supported yet. Name the paths explicitly, or use --tracked\n" +
          "to commit what the plugin staged this session.",
      );
      return 1;
    }

    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Resolve the path set: explicit args, or the plugin's session-tracked set.
    // One session-state handle, reused for the post-commit clear below.
    const store = flags.tracked ? sessionState(root) : null;
    let paths = args.slice();
    if (store) {
      if (paths.length) {
        output.error("Pass either explicit paths or --tracked, not both.");
        return 1;
      }
      paths = await store.getStagedPaths();
      if (!paths.length) {
        output.error("No plugin-tracked paths to commit (session state is empty).");
        return 1;
      }
    }

    if (!paths.length) {
      // The safety default: never guess. Bare `commit -m "msg"` lands here.
      output.error(
        'Refusing to commit with no paths. Name the paths to save:\n' +
          '  ideaspaces commit -m "<message>" <path>...\n' +
          "or use --tracked to commit what the plugin staged this session.",
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
      for (const p of paths) await store.clearStagedPath(p);
    }

    output.result(
      { commit_sha: sha, committed_paths: paths },
      `Committed ${paths.length} path(s): ${sha}`,
    );
    return 0;
  },
};
