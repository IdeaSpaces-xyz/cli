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
import { appendTrailers, isValidChangeId, type Op, type Trailers } from "@ideaspaces/sdk";
import { commitPaths, repoRoot, stagedPaths, isIdeaspacePath, GitError } from "../git.js";
import { ensureLocalIdentity } from "../auth/identity.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const OPS: readonly Op[] = ["create", "update", "move", "delete", "restructure", "capture"];

/**
 * Read the Change-layer trailer flags and fold them into the message. Stateless
 * by design: the caller (usually the MCP server holding an open Change) passes
 * the id/conversation/agent it is tracking; the CLI only stamps what it's given.
 *   --op <op>            one of create|update|move|delete|restructure|capture
 *   --change-id <chg_…>  the open Change's id
 *   --conversation <id>  the session that drove the commit
 *   --co-author <a[,b]>  agent principal(s) that assisted (comma-separated)
 * Returns the message unchanged when no trailer flag is set. Throws (via
 * appendTrailers) on an invalid Change-Id or a conflicting existing trailer.
 */
export function applyTrailerFlags(message: string, flags: Record<string, string | boolean>): string {
  const trailers: Trailers = {};

  const op = typeof flags.op === "string" ? flags.op.trim() : "";
  if (op) {
    if (!OPS.includes(op as Op)) {
      throw new Error(`Invalid --op "${op}". Expected one of: ${OPS.join(", ")}.`);
    }
    trailers.op = op as Op;
  }

  const changeId = typeof flags["change-id"] === "string" ? flags["change-id"].trim() : "";
  if (changeId) {
    if (!isValidChangeId(changeId)) {
      throw new Error(`Invalid --change-id "${changeId}". Expected a chg_… id (mint with: ideaspaces change new).`);
    }
    trailers.changeId = changeId;
  }

  const conversation = typeof flags.conversation === "string" ? flags.conversation.trim() : "";
  if (conversation) trailers.conversation = conversation;

  // The flag parser has no array support, so accept a comma-separated list for
  // the one multi-valued trailer.
  const coAuthor = typeof flags["co-author"] === "string" ? flags["co-author"] : "";
  const coAuthors = coAuthor.split(",").map((s) => s.trim()).filter(Boolean);
  if (coAuthors.length) trailers.coAuthoredBy = coAuthors;

  const anySet = trailers.op || trailers.changeId || trailers.conversation || trailers.coAuthoredBy;
  return anySet ? appendTrailers(message, trailers) : message;
}

export const commitCommand: CommandDef = {
  name: "commit",
  description: "Save staged captures — commits only the paths you name",
  usage: 'ideaspaces commit -m "<message>" <path>... | --all [--op <op>] [--change-id <chg_…>] [--conversation <id>] [--co-author <a[,b]>]',
  examples: [
    'ideaspaces commit -m "Capture auth decision" notes/auth.md',
    'ideaspaces commit -m "Save notes" --all   # all staged markdown / _agent/ paths',
    'ideaspaces commit -m "Capture" notes/auth.md --op capture --change-id chg_auth-1a2b --conversation sess_9 --co-author "agent:me-claude"',
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

    // Fold in any Change-layer trailers before the identity/commit step so a
    // bad --op / --change-id fails fast, before we touch git.
    let finalMessage: string;
    try {
      finalMessage = applyTrailerFlags(message, flags);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Attribute the commit to the logged-in OAuth identity so the server's
    // pre-receive hook accepts the eventual push. No-op when already wired.
    await ensureLocalIdentity(root);

    let sha: string;
    try {
      sha = commitPaths(finalMessage, paths, root);
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
