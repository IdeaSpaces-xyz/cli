import { resolve } from "node:path";
import {
  deriveGitBase,
  fetchAuthMe,
  UnauthorizedError,
  type AuthMeRepo,
  type AuthMeResponse,
} from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import {
  findSpaceFor,
  isUnpublishedForkRecord,
  saveSpace,
  withForkLineage,
} from "../auth/spaces.js";
import { identityEmail, identityName } from "../auth/identity.js";
import { isInsideWorkTree, normalizeRepoUrl, originUrl, setLocalConfig } from "../git.js";
import { createOutput } from "../output.js";
import {
  canonicalGitUrl,
  repoRouteNamespace,
  spaceRecordForRepo,
  repoKeys,
} from "../space-locator.js";
import type { CommandDef } from "../types.js";

export const linkCommand: CommandDef = {
  name: "link",
  description: "Bind an existing local clone to one of your spaces",
  usage: "ideaspaces link <dir> [space]",
  examples: [
    "ideaspaces link ./theone                  # auto-detect from the git remote",
    "ideaspaces link ./theone alice/theone     # bind to a specific space",
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
        const namespace = repoRouteNamespace(r, me.username);
        const slug = r.route_slug ?? r.slug;
        return r.repo_id === target || r.root_node_id === target || slug === target || `${namespace}/${slug}` === target;
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
      if (!repoKeys(repo, me, gitBase, config.apiUrl).includes(originKey)) {
        const expected = repo.root_node_id
          ? canonicalGitUrl(config.apiUrl, repo.root_node_id)
          : `${gitBase}/${repoRouteNamespace(repo, me.username)}/${repo.route_slug ?? repo.slug}.git`;
        output.error(
          `${dir}'s origin (${origin}) doesn't match ${repo.slug}.\n` +
            `Expected a clone of ${expected}.`,
        );
        return 1;
      }
    } else {
      // Auto-detect: the origin must match exactly one of the user's spaces.
      const matches = me.repos.filter((r) =>
        repoKeys(r, me, gitBase, config.apiUrl).includes(originKey),
      );
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

    const namespace = repoRouteNamespace(repo, me.username) ?? repo.hostname ?? me.username;
    if (!namespace) {
      output.error("Could not resolve the Space route for display.");
      return 1;
    }

    // Bind the folder so `sync`/the desktop treat it as a clone of this space.
    //
    // The server's view is the base, and exactly two fields are carried over:
    // a fork's `source_root_node_id`/`source_head`, which `fork` alone writes
    // and nothing can reconstruct, so re-linking to fix a mismatch must not
    // cost them. Carrying the *whole* old record instead would be unsafe —
    // `spaceRecordForRepo` emits `root_node_id` only when the repo has one, so
    // re-pointing a folder from Space A to a legacy Space B would leave A's
    // root id under B's name, and `resolveSpaceBinding`'s first rung trusts a
    // recorded root id without re-checking it. That is a cross-Space read.
    //
    // Lineage travels only when the binding stays the same Space: repointed
    // somewhere else, this clone's old source is no longer about it.
    const previous = findSpaceFor(dir);
    if (
      previous &&
      isUnpublishedForkRecord(previous) &&
      repo.root_node_id !== previous.root_node_id
    ) {
      output.error(
        `This folder is an unpublished local fork with identity ${previous.root_node_id}. ` +
          "Refusing to replace it with a different hosted Space. Publish it, or explicitly " +
          "discard the local binding with `ideaspaces forget .` before linking another Space.",
      );
      return 1;
    }
    try {
      saveSpace(dir, withForkLineage(spaceRecordForRepo(repo, me.username), previous));
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
      { repo_id: repo.repo_id, root_node_id: repo.root_node_id ?? null, slug: repo.slug, namespace, path: dir },
      `Linked ${namespace}/${repo.slug} → ${dir}`,
    );
    return 0;
  },
};
