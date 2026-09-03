import { resolve } from "node:path";
import { deriveGitBase, fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { saveSpace } from "../auth/spaces.js";
import { identityEmail, identityName } from "../auth/identity.js";
import { cloneRepo, setLocalConfig } from "../git.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { hasRootAction } from "../root-actions.js";
import {
  canonicalGitUrl,
  canonicalSpaceUrl,
  parseSpaceLocator,
  repoDisplaySlug,
  repoRouteNamespace,
  spaceRecordForRepo,
} from "../space-locator.js";
import type { CommandDef } from "../types.js";

export const cloneCommand: CommandDef = {
  name: "clone",
  description: "Clone an authorized Space into a local folder",
  usage: "ideaspaces clone <space-url|legacy-space> [dir]",
  examples: [
    "ideaspaces clone https://ideaspaces.xyz/spaces/n_0123456789abcdef01234567",
    "ideaspaces clone alice/notes ./n       # legacy compatibility locator",
  ],
  async run(args, _flags, global) {
    const output = createOutput(global);

    const target = args[0];
    if (!target) {
      output.error("Usage: ideaspaces clone <space> [dir]");
      return 1;
    }

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    let me;
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

    const urlLike = /^[a-z][a-z0-9+.-]*:/i.test(target);
    let rootNodeId: string | undefined;
    if (urlLike) {
      try {
        rootNodeId = parseSpaceLocator(target, config.apiUrl).rootNodeId;
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    // Canonical URLs match stable root identity. Legacy repo ID, slug, and
    // namespace/slug inputs remain compatibility locators during migration.
    const matches = me.repos.filter((r) => {
      if (rootNodeId) return r.root_node_id === rootNodeId;
      const namespace = repoRouteNamespace(r, me.username);
      const slug = repoDisplaySlug(r);
      return r.repo_id === target || slug === target || `${namespace}/${slug}` === target;
    });
    if (matches.length === 0) {
      output.error(`No space matches "${target}" in your account catalog. Run \`ideaspaces repos\` to list yours.`);
      return 1;
    }
    if (matches.length > 1) {
      output.error(`"${target}" is ambiguous — use its canonical Space URL.`);
      return 1;
    }

    const repo = matches[0];
    if (!hasRootAction(repo, "clone")) {
      output.error(`Space "${target}" is in your account catalog but does not allow clone.`);
      return 1;
    }
    const namespace = repoRouteNamespace(repo, me.username);
    const slug = repoDisplaySlug(repo);
    const stableRoot = repo.root_node_id ?? rootNodeId;
    if (!stableRoot && !namespace) {
      output.error("Could not resolve stable Space identity or a compatibility route.");
      return 1;
    }

    const url = stableRoot
      ? canonicalGitUrl(config.apiUrl, stableRoot)
      : `${deriveGitBase(config.apiUrl)}/${namespace}/${slug}.git`;
    const dir = resolve(args[1] ?? slug);

    // Self-heal the credential helper before the clone's network auth — covers
    // a config written by an older CLI or a moved executable path (idempotent,
    // best-effort). See git-credential-helper.ts.
    await registerGitCredentialHelper();

    output.progress(
      `Cloning ${stableRoot ? canonicalSpaceUrl(config.apiUrl, stableRoot) : `${namespace}/${slug}`}…`,
    );
    try {
      cloneRepo(url, dir);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    // Verify the portable declaration against the canonical origin before
    // trusting either as this checkout's identity. A legacy clone without a
    // declaration remains valid and reports legacy_unstamped.
    let rootIdentity;
    try {
      rootIdentity = inspectLocalRootIdentity(dir, config.apiUrl);
    } catch (err) {
      output.error(`Clone succeeded, but Space identity could not be inspected: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (["invalid", "drift", "ambiguous"].includes(rootIdentity.state)) {
      output.error(
        `Clone succeeded, but its root identity is ${rootIdentity.state}. The folder was not bound locally; inspect _agent/foundation.md and origin before using it.`,
      );
      return 1;
    }
    if (stableRoot && rootIdentity.root_node_id !== stableRoot) {
      output.error(
        `Clone succeeded, but the checkout reports ${rootIdentity.root_node_id ?? "no root identity"} instead of ${stableRoot}. The folder was not bound locally.`,
      );
      return 1;
    }

    // Bind the folder to the space so `sync` knows what it is. The clone already
    // succeeded — a registry write failure is a warning, not a hard failure.
    try {
      saveSpace(dir, spaceRecordForRepo(repo, me.username));
    } catch {
      output.error("Clone succeeded but the folder could not be bound — re-run clone to bind it.");
    }

    // Wire the OAuth identity into the new clone so commits made in it pass the
    // server's attribution hook and read cleanly in history. `me` is already in
    // hand from the clone resolution above — no extra round-trip. Best-effort: a
    // config failure doesn't undo a successful clone (`commit` re-ensures it).
    if (me.username) {
      try {
        setLocalConfig("user.email", identityEmail(me.username), dir);
        setLocalConfig("user.name", identityName({ name: me.name, username: me.username }), dir);
      } catch {
        // Non-fatal — commit will set it on first use.
      }
    }

    const spaceUrl = stableRoot ? canonicalSpaceUrl(config.apiUrl, stableRoot) : null;
    output.result(
      {
        repo_id: repo.repo_id,
        root_node_id: stableRoot ?? null,
        slug,
        namespace,
        space_url: spaceUrl,
        remote_url: url,
        path: dir,
        identity_state: rootIdentity.state,
      },
      `Cloned ${spaceUrl ?? `${namespace}/${slug}`} → ${dir}`,
    );
    return 0;
  },
};
