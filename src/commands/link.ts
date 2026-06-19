import { resolve } from "node:path";
import {
  deriveGitBase,
  fetchAuthMe,
  UnauthorizedError,
  type AuthMeRepo,
  type AuthMeResponse,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { saveSpace } from "../auth/spaces.js";
import { identityEmail, identityName } from "../auth/identity.js";
import { isInsideWorkTree, normalizeRepoUrl, originUrl, setLocalConfig } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

/** Canonical `host/ns/slug` key for one of the user's spaces, or null. */
function repoKey(repo: AuthMeRepo, me: AuthMeResponse, gitBase: string): string | null {
  const namespace = repo.hostname ?? me.username;
  if (!namespace) return null;
  return normalizeRepoUrl(`${gitBase}/${namespace}/${repo.slug}.git`);
}

export const linkCommand: CommandDef = {
  name: "link",
  description: "Bind an existing local clone to one of your spaces",
  usage: "ideaspaces link <dir> [space]",
  examples: [
    "ideaspaces link ./theone                  # auto-detect from the git remote",
    "ideaspaces link ./theone ernests_s/theone # bind to a specific space",
  ],
  async run(args, _flags, global) {
    const output = createOutput(global);

    const dirArg = args[0];
    if (!dirArg) {
      output.error("Usage: ideaspaces link <dir> [space]");
      return 1;
    }
    const dir = resolve(dirArg);

    // The folder must be a clone we can verify — never bind a non-repo (sync
    // would have nothing to push to) or a repo with no origin (can't tell which
    // space it is).
    if (!isInsideWorkTree(dir)) {
      output.error(`${dir} is not a git repository. Use \`clone\` to make one, or point at an existing clone.`);
      return 1;
    }
    const origin = originUrl(dir);
    if (!origin) {
      output.error(`${dir} has no \`origin\` remote — can't tell which space it belongs to.`);
      return 1;
    }
    const originKey = normalizeRepoUrl(origin);
    if (!originKey) {
      output.error(`Could not parse the origin remote: ${origin}`);
      return 1;
    }

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    output.progress(`Linking ${dir}…`);

    let me: AuthMeResponse;
    try {
      me = await fetchAuthMe(config);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error("Session expired. Run `ideaspaces login`.");
        return 1;
      }
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    const gitBase = deriveGitBase(config.apiUrl);
    const target = args[1];
    let repo: AuthMeRepo;

    if (target) {
      // Explicit: resolve the named space, then confirm the folder is its clone.
      const matches = me.repos.filter((r) => {
        const namespace = r.hostname ?? me.username;
        return r.repo_id === target || r.slug === target || `${namespace}/${r.slug}` === target;
      });
      if (matches.length === 0) {
        output.error(`No space matches "${target}". Run \`ideaspaces repos\` to list yours.`);
        return 1;
      }
      if (matches.length > 1) {
        output.error(`"${target}" is ambiguous — use namespace/slug or the repo_id.`);
        return 1;
      }
      repo = matches[0];
      if (repoKey(repo, me, gitBase) !== originKey) {
        const namespace = repo.hostname ?? me.username;
        output.error(
          `${dir}'s origin (${origin}) doesn't match ${repo.slug}.\n` +
            `Expected a clone of ${gitBase}/${namespace}/${repo.slug}.git.`,
        );
        return 1;
      }
    } else {
      // Auto-detect: the origin must match exactly one of the user's spaces.
      const matches = me.repos.filter((r) => repoKey(r, me, gitBase) === originKey);
      if (matches.length === 0) {
        output.error(
          `${dir}'s origin (${origin}) isn't a clone of one of your spaces.\n` +
            "Run `ideaspaces repos` to see them, or pass the space explicitly.",
        );
        return 1;
      }
      if (matches.length > 1) {
        output.error(
          `${dir}'s origin matches more than one space — name it: ideaspaces link <dir> <space>.`,
        );
        return 1;
      }
      repo = matches[0];
    }

    const namespace = repo.hostname ?? me.username;
    if (!namespace) {
      output.error("Could not resolve the space namespace.");
      return 1;
    }

    // Bind the folder so `sync`/the desktop treat it as a clone of this space.
    try {
      saveSpace(dir, { repo_id: repo.repo_id, slug: repo.slug, namespace });
    } catch {
      output.error("Verified the folder, but could not write the clone registry.");
      return 1;
    }

    // Wire the OAuth identity so commits made here pass the attribution hook —
    // an existing clone may carry an unrelated `user.email`. Best-effort, as in
    // `clone`: a config failure doesn't undo a successful bind.
    if (me.username) {
      try {
        setLocalConfig("user.email", identityEmail(me.username), dir);
        setLocalConfig("user.name", identityName({ name: me.name, username: me.username }), dir);
      } catch {
        // Non-fatal — commit re-ensures it.
      }
    }

    output.result(
      { repo_id: repo.repo_id, slug: repo.slug, namespace, path: dir },
      `Linked ${namespace}/${repo.slug} → ${dir}`,
    );
    return 0;
  },
};
