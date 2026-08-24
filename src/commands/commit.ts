/**
 * `ideaspaces commit -m "<message>" <path>...` — the explicit save.
 *
 * The CLI owns terminal compatibility: explicit paths or `--all`, local Git
 * executable selection, and repo-local identity. The protocol effect owns the
 * exact reviewed path commit, CAS, trailers, and typed partial failures.
 */

import { join } from "node:path";
import {
  isIdeaspacePath,
  isValidChangeId,
  pathRevision,
  type LocalEffectIdentity,
  type LocalEffectTrailers,
  type Op,
  type PathRevision,
} from "@ideaspaces/protocol";
import { commitPaths as commitReviewedPaths } from "@ideaspaces/protocol/local-effects";
import {
  canonicalRepoRoot,
  emitEffectFailure,
  gitIdentityConfigForEffects,
  localEffectCapabilities,
  localEffectError,
  stagedPathsForEffects,
  toPortableRepoPath,
} from "../local-effects-adapter.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const OP_SET = {
  create: true,
  update: true,
  move: true,
  delete: true,
  restructure: true,
  capture: true,
} satisfies Record<Op, true>;
const OPS = Object.keys(OP_SET) as Op[];

const CANONICAL_CO_AUTHOR = /^[^<>\r\n]+ <agent:[^<>\s]+@ideaspaces>$/;
const LEGACY_AGENT_PRINCIPAL = /^agent:([^<>\s]+)$/;

/** Translate terminal trailer flags into the protocol's structured request. */
export function parseTrailerFlags(flags: Record<string, string | boolean>): LocalEffectTrailers {
  const trailers: LocalEffectTrailers = {};

  const op = typeof flags.op === "string" ? flags.op.trim() : "";
  if (op) {
    if (!(op in OP_SET)) {
      throw new Error(`Invalid --op "${op}". Expected one of: ${OPS.join(", ")}.`);
    }
    trailers.op = op as Op;
  }

  const changeId = typeof flags["change-id"] === "string" ? flags["change-id"].trim() : "";
  if (changeId) {
    if (!isValidChangeId(changeId)) {
      throw new Error(`Invalid --change-id "${changeId}". Expected a chg_… id (mint with: ideaspaces change new).`);
    }
    trailers.change_id = changeId;
  }

  const conversation = typeof flags.conversation === "string" ? flags.conversation.trim() : "";
  if (conversation) trailers.conversation = conversation;

  const coAuthor = typeof flags["co-author"] === "string" ? flags["co-author"] : "";
  const coAuthors = coAuthor.split(",").map((value) => value.trim()).filter(Boolean);
  if (coAuthors.length) {
    trailers.co_authored_by = coAuthors.map(canonicalCoAuthor);
  }

  return trailers;
}

/** Preserve current MCP/Pi argv while upgrading history to protocol identity. */
function canonicalCoAuthor(value: string): string {
  if (CANONICAL_CO_AUTHOR.test(value)) return value;
  const legacy = LEGACY_AGENT_PRINCIPAL.exec(value);
  if (legacy) {
    const id = legacy[1];
    return `${id} <agent:${id}@ideaspaces>`;
  }
  throw new Error(
    `Invalid --co-author "${value}". Expected agent:<id> or Name <agent:<id>@ideaspaces>.`,
  );
}

async function resolveIdentity(
  root: string,
  flags: Record<string, string | boolean>,
): Promise<LocalEffectIdentity> {
  const explicitName = typeof flags["author-name"] === "string" ? flags["author-name"].trim() : "";
  const explicitEmail = typeof flags["author-email"] === "string" ? flags["author-email"].trim() : "";
  if (explicitName || explicitEmail) {
    if (!explicitName || !explicitEmail) {
      throw new Error("Use --author-name and --author-email together.");
    }
    return { name: explicitName, email: explicitEmail };
  }

  const name = (await gitIdentityConfigForEffects(root, "user.name"))?.trim() ?? "";
  const email = (await gitIdentityConfigForEffects(root, "user.email"))?.trim() ?? "";
  if (!name || !email) {
    throw new Error(
      "No complete Git identity. Run `git config --local user.name <name>` and " +
        "`git config --local user.email <email>`, or pass --author-name and --author-email.",
    );
  }
  return { name, email };
}

export const commitCommand: CommandDef = {
  name: "commit",
  description: "Save staged captures — commits only the paths you name",
  usage:
    'ideaspaces commit -m "<message>" <path>... | --all [--author-name <name> --author-email <email>] [--op <op>] [--change-id <chg_…>] [--conversation <id>] [--co-author <agent>]',
  examples: [
    'ideaspaces commit -m "Capture auth decision" notes/auth.md',
    'ideaspaces commit -m "Save notes" --all   # all staged markdown / _agent/ paths',
    'ideaspaces commit -m "Capture" notes/auth.md --op capture --change-id chg_auth-1a2b --conversation sess_9 --co-author "agent:me-claude"',
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const message = String(flags.m ?? flags.message ?? "").trim();
    if (!message) {
      const failure = localEffectError(
        "commit_paths",
        "invalid_message",
        "preflight",
        'A commit message is required: ideaspaces commit -m "<message>" <path>...',
      );
      emitEffectFailure(output, global, failure);
      return 1;
    }

    let root: string;
    try {
      root = canonicalRepoRoot();
    } catch (error) {
      const failure = localEffectError(
        "commit_paths",
        "not_git_repository",
        "preflight",
        "Commit requires a canonical Git worktree.",
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      emitEffectFailure(output, global, failure);
      return 1;
    }

    if (args.length > 0 && flags.all) {
      const failure = localEffectError(
        "commit_paths",
        "invalid_request",
        "preflight",
        "Use exactly one of: explicit <path>..., or --all.",
      );
      emitEffectFailure(output, global, failure);
      return 1;
    }

    let paths: string[];
    if (flags.all) {
      let staged: string[];
      try {
        staged = await stagedPathsForEffects(root);
      } catch (error) {
        const failure = localEffectError(
          "commit_paths",
          "git_executor_failed",
          "preflight",
          "Git could not resolve the staged path set for --all.",
          undefined,
          error instanceof Error ? error.message : String(error),
        );
        emitEffectFailure(output, global, failure);
        return 1;
      }
      if (!staged.length) {
        const failure = localEffectError(
          "commit_paths",
          "nothing_to_commit",
          "commit",
          "Nothing staged to commit.",
        );
        emitEffectFailure(output, global, failure);
        return 1;
      }
      paths = staged.filter(isIdeaspacePath);
      const other = staged.filter((path) => !isIdeaspacePath(path));
      if (!paths.length) {
        const failure = localEffectError(
          "commit_paths",
          "nothing_to_commit",
          "commit",
          "No staged ideaspace paths (Markdown or _agent/).",
          undefined,
          `Staged non-knowledge paths: ${other.join(", ")}`,
        );
        emitEffectFailure(output, global, failure);
        return 1;
      }
      if (other.length) {
        output.log(`Leaving ${other.length} non-ideaspace staged path(s) for you to commit: ${other.join(", ")}`);
      }
    } else {
      const converted: string[] = [];
      for (const input of args) {
        const path = toPortableRepoPath(input, root);
        if (!path) {
          const failure = localEffectError(
            "commit_paths",
            "path_escape",
            "preflight",
            "The selected path is outside the repository root.",
            input,
          );
          emitEffectFailure(output, global, failure);
          return 1;
        }
        converted.push(path);
      }
      paths = converted;
    }

    paths = [...new Set(paths)];
    const legacyPaths = flags.all
      ? [...paths]
      : paths.map((path) => join(root, ...path.split("/")));
    if (!paths.length) {
      const failure = localEffectError(
        "commit_paths",
        "invalid_request",
        "preflight",
        'Refusing to commit with no paths. Name paths or use --all.',
      );
      emitEffectFailure(output, global, failure);
      return 1;
    }

    let trailers: LocalEffectTrailers;
    try {
      trailers = parseTrailerFlags(flags);
    } catch (error) {
      const failure = localEffectError(
        "commit_paths",
        "invalid_trailers",
        "preflight",
        error instanceof Error ? error.message : String(error),
      );
      emitEffectFailure(output, global, failure);
      return 1;
    }

    let identity: LocalEffectIdentity;
    try {
      identity = await resolveIdentity(root, flags);
    } catch (error) {
      const failure = localEffectError(
        "commit_paths",
        "invalid_identity",
        "preflight",
        error instanceof Error ? error.message : String(error),
      );
      emitEffectFailure(output, global, failure);
      return 1;
    }

    const selected: Array<{ path: string; expected_revision: PathRevision }> = [];
    for (const path of paths) {
      const read = await pathRevision(
        root,
        path,
        localEffectCapabilities.git,
        localEffectCapabilities.filesystem,
      );
      if (read.status === "error") {
        const failure = localEffectError(
          "commit_paths",
          read.code,
          read.phase,
          read.message,
          read.path,
          read.detail,
        );
        emitEffectFailure(output, global, failure);
        return 1;
      }
      selected.push({ path, expected_revision: read.revision });
    }

    const result = await commitReviewedPaths(
      {
        operation: "commit_paths",
        root,
        paths: selected,
        message,
        trailers,
        author: identity,
        committer: identity,
      },
      localEffectCapabilities,
    );

    if (result.status !== "ok") {
      emitEffectFailure(output, global, result);
      return 1;
    }

    output.result(
      {
        ...result,
        commit_sha: result.commit_oid,
        committed_paths: legacyPaths,
      },
      `Committed ${paths.length} path(s): ${result.commit_oid}`,
    );
    return 0;
  },
};
