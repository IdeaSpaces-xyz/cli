/**
 * `ideaspaces publish` — host this folder as a remote ideaspace.
 *
 * Flow:
 *   1. Load credentials (require login).
 *   2. Fetch /auth/me for the OAuth-resolved username.
 *   3. POST /repos with name + slug + hostname → server-side bare repo.
 *   4. Set local git user.email = person:<username>@ideaspaces in cwd so
 *      the pre-receive identity check resolves the author without needing
 *      a Co-authored-by trailer per commit.
 *   5. git remote add origin → git push -u origin main. The server's bare
 *      repo accepts the ref creation; force-push guard short-circuits on
 *      ZERO_OID for new refs.
 *   6. Persist {repo_id, slug, namespace} to ~/.ideaspaces/spaces.json
 *      keyed by absolute folder path.
 *
 * Pre-receive enforces a 200KB per-blob size cap and identity strict-match
 * on the tip commit. Local git config picks up the identity automatically;
 * size cap surfaces as a structured rejection if a blob is too large.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createOutput } from "../output.js";
import { loadStoredCredentials } from "../auth/credentials.js";
import { fetchAuthMe, createRepo } from "../auth/api.js";
import { findSpaceFor, saveSpace } from "../auth/spaces.js";
import type { CommandDef } from "../types.js";

interface PublishFlags {
  slug?: string;
  hostname?: string;
  name?: string;
  force?: boolean;
}

const GIT_HOST = "git.ideaspaces.xyz";

function runGit(cwd: string, args: string[]): { ok: boolean; stderr: string; stdout: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return {
    ok: r.status === 0,
    stderr: (r.stderr || "").trim(),
    stdout: (r.stdout || "").trim(),
  };
}

function defaultGitUrl(namespace: string, slug: string): string {
  const base = (process.env.IS_GIT_URL || `https://${GIT_HOST}`).replace(/\/+$/, "");
  return `${base}/${namespace}/${slug}.git`;
}

export const publishCommand: CommandDef = {
  name: "publish",
  description: "Publish this folder as a remote ideaspace (login required)",
  usage: "ideaspaces publish [--slug <slug>] [--name <name>] [--hostname <host>] [--force]",
  examples: [
    "ideaspaces publish                     # publish current directory; slug from folder name",
    "ideaspaces publish --slug my-notes     # explicit slug",
    "ideaspaces publish --hostname acme.com # publish into an org space (must be a member)",
    "ideaspaces publish --force             # force a fresh remote even if this dir already mapped",
  ],
  async run(_args, rawFlags, global) {
    const output = createOutput(global);
    const flags = rawFlags as PublishFlags;
    // process.cwd() returns an absolute path; no resolve() needed.
    const cwd = process.cwd();

    if (!existsSync(join(cwd, ".git"))) {
      output.error("Not a git repo. Run `ideaspaces create` first, or `git init` here.");
      return 1;
    }

    // Detect the current branch up-front. Push uses this name on origin —
    // a repo created with `git init -b master` (older git defaults) pushes
    // to `master`, not `main`. The server's HEAD symbolic-ref convention
    // is `main`, but the bare repo accepts ref creation under any name.
    const branchResult = runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
    if (!branchResult.ok) {
      output.error("Couldn't determine the current branch — is HEAD detached?");
      return 1;
    }
    const branch = branchResult.stdout;

    const stored = loadStoredCredentials();
    if (!stored) {
      output.error("Not logged in. Run `ideaspaces login` first.");
      return 1;
    }
    const config = { apiUrl: stored.api_url, apiKey: stored.api_key };

    let me;
    try {
      me = await fetchAuthMe(config);
    } catch (err) {
      output.error(`Couldn't reach the IdeaSpaces server: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (!me.username) {
      output.error("Account has no username yet. Complete onboarding before publishing.");
      return 1;
    }

    // Re-publish idempotency: if this folder is already mapped to a remote,
    // reuse that record instead of creating another server-side repo.
    // `--force` opts into a fresh remote (drops the old mapping locally —
    // the orphaned server repo stays accessible by repo_id).
    const existing = findSpaceFor(cwd);
    let repo: { repo_id: string; slug: string; name: string };
    let namespace: string;

    if (existing && !flags.force) {
      output.log(
        `This folder is already published as ${existing.namespace}/${existing.slug} ` +
          `(repo_id=${existing.repo_id}). Re-pushing to the same remote. ` +
          `Use --force to provision a new one — the old server repo isn't deleted, ` +
          `just unlinked from this folder.`,
      );
      repo = { repo_id: existing.repo_id, slug: existing.slug, name: flags.name?.toString() || existing.slug };
      namespace = existing.namespace;
    } else {
      const name = flags.name?.toString() || basename(cwd);
      const slug = flags.slug?.toString();
      const hostname = flags.hostname?.toString() ?? null;
      namespace = hostname ?? me.username;

      try {
        repo = await createRepo(config, { name, slug, hostname });
      } catch (err) {
        output.error(`Couldn't create remote space: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    // Identity wiring — set user.email so commits resolve to person:<user>
    // via the pre-receive hook's email-format identity regex. Leave
    // user.name alone — display name stays the user's choice.
    const identityEmail = `person:${me.username}@ideaspaces`;
    const setEmail = runGit(cwd, ["config", "--local", "user.email", identityEmail]);
    if (!setEmail.ok) {
      output.error(`git config user.email failed: ${setEmail.stderr}`);
      return 1;
    }

    const remoteUrl = defaultGitUrl(namespace, repo.slug);
    // Replace any existing origin (idempotent re-publish from same dir).
    const existingRemote = runGit(cwd, ["remote", "get-url", "origin"]);
    if (existingRemote.ok) {
      const setUrl = runGit(cwd, ["remote", "set-url", "origin", remoteUrl]);
      if (!setUrl.ok) {
        output.error(`git remote set-url failed: ${setUrl.stderr}`);
        return 1;
      }
    } else {
      const addRemote = runGit(cwd, ["remote", "add", "origin", remoteUrl]);
      if (!addRemote.ok) {
        output.error(`git remote add failed: ${addRemote.stderr}`);
        return 1;
      }
    }

    output.progress(`Pushing ${branch} to ${remoteUrl} ...`);
    const push = runGit(cwd, ["push", "-u", "origin", branch]);
    if (!push.ok) {
      output.error(
        `Push failed:\n${push.stderr}\n` +
          `If a blob exceeded the 200KB cap, shrink it or move it out of the repo.`,
      );
      return 1;
    }

    saveSpace(cwd, {
      repo_id: repo.repo_id,
      slug: repo.slug,
      namespace,
    });

    output.result(
      {
        repo_id: repo.repo_id,
        slug: repo.slug,
        namespace,
        remote_url: remoteUrl,
        identity_email: identityEmail,
      },
      [
        `Published ${repo.name} → ${remoteUrl}`,
        `Local git identity set to ${identityEmail} (this dir only — your global git config is untouched).`,
      ].join("\n"),
    );
    return 0;
  },
};
