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
import { fetchAuthMe, createRepo, deriveGitBase, deriveWebBase, UnauthorizedError } from "../auth/api.js";
import { findSpaceFor, saveSpace } from "../auth/spaces.js";
import { identityEmail as formatIdentityEmail } from "../auth/identity.js";
import type { CommandDef } from "../types.js";
import { hasIdentityProblems, renderIdentityProblems, scanMarkdownIdentityFiles } from "../identity-report.js";

interface PublishFlags {
  slug?: string;
  hostname?: string;
  name?: string;
  force?: boolean;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stderr: string; stdout: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  // ENOENT and friends — git not on PATH. spawnSync returns status: null and
  // sets r.error; without this guard the caller surfaces an empty-stderr 1.
  if (r.error) {
    return { ok: false, stderr: `git not available: ${r.error.message}`, stdout: "" };
  }
  return {
    ok: r.status === 0,
    stderr: (r.stderr || "").trim(),
    stdout: (r.stdout || "").trim(),
  };
}

function defaultGitUrl(apiUrl: string, namespace: string, slug: string): string {
  return `${deriveGitBase(apiUrl)}/${namespace}/${slug}.git`;
}

function spaceWebUrl(apiUrl: string, namespace: string, slug: string): string {
  return `${deriveWebBase(apiUrl)}/${namespace}/${slug}`;
}

const SIZE_CAP_MARKERS = ["size cap", "too large", "exceeds"];

/** Coerce a folder basename into a server-acceptable slug.
 *
 * Server requires `^[a-z0-9][a-z0-9-]*$` (max 64). CamelCase → kebab
 * fires only between a lowercase/digit and an uppercase, so consecutive
 * caps collapse (`XMLSpace` → `xmlspace`, not `x-m-l-space`). Exported
 * for unit tests.
 */
export function slugify(input: string): string {
  let s = input
    // Insert dash between lowercase/digit and uppercase: theKnowledge → the-Knowledge
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    // Collapse non-alphanumeric runs to a single dash.
    .replace(/[^a-z0-9]+/g, "-")
    // Trim leading/trailing dashes.
    .replace(/^-+|-+$/g, "");
  if (s.length === 0) return "space";
  return s.slice(0, 64).replace(/-+$/, "");
}

async function checkMarkdownIdentities(cwd: string): Promise<string | null> {
  const files = trackedMarkdownFiles(cwd);
  if (!files.length) return null;

  const scan = await scanMarkdownIdentityFiles(files);
  if (!hasIdentityProblems(scan)) return null;

  return renderIdentityProblems(scan, {
    cwd,
    header: [
      "Cannot publish yet: markdown identity check failed.",
      "Every committed markdown file needs a stable node_id before it can be pushed.",
      "",
    ],
    footer: [
      "Fix missing IDs with: `ideaspaces id --fix .`",
      "Fix copied/duplicate IDs with: `ideaspaces id --regenerate <path>`",
      "Then commit the identity changes and re-run `ideaspaces publish`.",
    ],
  });
}

function trackedMarkdownFiles(cwd: string): string[] {
  const r = spawnSync("git", ["-C", cwd, "ls-files", "-z", "--", "*.md"], { encoding: "utf-8" });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(r.stderr.trim() || "git ls-files failed while checking markdown identities");
  }
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => join(cwd, path));
}

export const publishCommand: CommandDef = {
  name: "publish",
  description: "Publish this folder as a remote ideaspace (tracked .md files need node_id)",
  usage: "ideaspaces publish [--slug <slug>] [--name <name>] [--hostname <host>] [--force]",
  examples: [
    "ideaspaces publish                     # publish current directory; preflights tracked .md node_id fields",
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

    // Detect the current branch up-front. The server's HEAD symbolic-ref
    // points at refs/heads/main, so publishing requires the local branch
    // to be `main` — otherwise local and remote drift, breaking clone HEAD
    // and `git pull origin <branch>` for the user later. Refuse with an
    // actionable hint if the local branch is something else; let the
    // conversational layer (`/is-publish`) offer the rename, or terminal
    // users run `git branch -m main` manually.
    const branchResult = runGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
    if (!branchResult.ok) {
      output.error("Couldn't determine the current branch — is HEAD detached?");
      return 1;
    }
    const branch = branchResult.stdout;
    if (branch !== "main") {
      output.error(
        `Local branch is \`${branch}\`; IdeaSpaces uses \`main\` as the default. ` +
          `Rename with \`git branch -m main\` and retry, or use \`/is-publish\` from Claude Code which offers to rename for you.`,
      );
      return 1;
    }

    let identityProblem: string | null;
    try {
      identityProblem = await checkMarkdownIdentities(cwd);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (identityProblem) {
      output.error(identityProblem);
      return 1;
    }

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
      if (err instanceof UnauthorizedError) {
        output.error("Your IdeaSpaces session has expired. Run `ideaspaces login` to refresh, then retry publish.");
        return 1;
      }
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
      // Flags that only affect a *fresh* create silently no-op here.
      // Reject early so the user knows their request didn't apply.
      const ignored = [
        flags.name && "--name",
        flags.slug && "--slug",
        flags.hostname && "--hostname",
      ].filter(Boolean);
      if (ignored.length > 0) {
        output.error(
          `${ignored.join(", ")} only apply on first publish. ` +
            `This folder is already mapped to ${existing.namespace}/${existing.slug}; ` +
            `re-publish reuses that record. Use --force to provision a new remote.`,
        );
        return 1;
      }

      output.log(
        `This folder is already published as ${existing.namespace}/${existing.slug} ` +
          `(repo_id=${existing.repo_id}). Re-pushing to the same remote. ` +
          `Use --force to provision a new one — the old server repo isn't deleted, ` +
          `just unlinked from this folder.`,
      );
      repo = { repo_id: existing.repo_id, slug: existing.slug, name: existing.slug };
      namespace = existing.namespace;
    } else {
      const folderName = basename(cwd);
      const name = flags.name?.toString() || folderName;
      // Server enforces ^[a-z0-9][a-z0-9-]*$ on slug. If the user passes
      // --slug, trust them but still normalize so a casing slip doesn't
      // become a 422. Otherwise derive from the folder basename.
      const slugInput = flags.slug?.toString() || folderName;
      const slug = slugify(slugInput);
      // Surface the normalization when it changes the input. A user who
      // typed `--slug My_Space` (or pointed publish at a CamelCase
      // folder) deserves to see that the URL slug is `my-space`, not
      // discover it later from the remote URL.
      if (slug !== slugInput) {
        output.log(`Using slug: ${slug} (normalized from "${slugInput}")`);
      }
      const hostname = flags.hostname?.toString() ?? null;
      namespace = hostname ?? me.username;

      try {
        repo = await createRepo(config, { name, slug, hostname });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          output.error("Your IdeaSpaces session has expired. Run `ideaspaces login` to refresh, then retry publish.");
          return 1;
        }
        output.error(`Couldn't create remote space: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    // Identity wiring — set user.email so commits resolve to person:<user>
    // via the pre-receive hook's email-format identity regex. Leave
    // user.name alone — display name stays the user's choice.
    const identityEmail = formatIdentityEmail(me.username);
    const setEmail = runGit(cwd, ["config", "--local", "user.email", identityEmail]);
    if (!setEmail.ok) {
      output.error(`git config user.email failed: ${setEmail.stderr}`);
      return 1;
    }

    // First-publish only — amending already-pushed commits creates divergence.
    if (!existing || flags.force) {
      const tipAuthor = runGit(cwd, ["log", "-1", "--format=%ae"]);
      if (!tipAuthor.ok) {
        output.log("Could not read tip author; skipping author rewrite. If push fails the identity check, fix git history manually.");
      } else if (tipAuthor.stdout && tipAuthor.stdout !== identityEmail) {
        output.log(`Rewriting tip commit author to ${identityEmail} to satisfy the pre-receive identity check.`);
        const amend = runGit(cwd, ["commit", "--amend", "--no-edit", "--reset-author"]);
        if (!amend.ok) {
          // Common failure mode: commit.gpgsign=true with no signing key for the IdeaSpaces email.
          const gpgRelated = /gpg|signing|secret key/i.test(amend.stderr);
          const hint = gpgRelated
            ? `\nIf you have commit signing on (\`commit.gpgsign=true\`), either configure a key for ${identityEmail} or run \`git config --local commit.gpgsign false\` in this dir.`
            : "";
          output.error(`git commit --amend failed: ${amend.stderr}${hint}`);
          return 1;
        }
      }
    }

    const remoteUrl = defaultGitUrl(config.apiUrl, namespace, repo.slug);
    // Replace any existing origin (idempotent re-publish from same dir).
    const existingRemote = runGit(cwd, ["remote", "get-url", "origin"]);
    if (existingRemote.ok) {
      if (existingRemote.stdout && existingRemote.stdout !== remoteUrl) {
        output.log(`Replacing existing origin: ${existingRemote.stdout} → ${remoteUrl}`);
      }
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

    output.progress(`Pushing main to ${remoteUrl} ...`);
    const push = runGit(cwd, ["push", "-u", "origin", "main"]);
    if (!push.ok) {
      const sizeRelated = SIZE_CAP_MARKERS.some((m) => push.stderr.includes(m));
      const hint = sizeRelated
        ? "\nA blob exceeded the 200KB cap — shrink it or move it out of the repo."
        : "";
      output.error(`Push failed:\n${push.stderr}${hint}`);
      return 1;
    }

    saveSpace(cwd, {
      repo_id: repo.repo_id,
      slug: repo.slug,
      namespace,
    });

    const webUrl = spaceWebUrl(config.apiUrl, namespace, repo.slug);
    output.result(
      {
        repo_id: repo.repo_id,
        slug: repo.slug,
        namespace,
        remote_url: remoteUrl,
        web_url: webUrl,
        identity_email: identityEmail,
      },
      [
        `Published ${repo.name}.`,
        `View: ${webUrl}`,
        `Git remote: ${remoteUrl}`,
        `Local git identity set to ${identityEmail} (this dir only — your global git config is untouched).`,
      ].join("\n"),
    );
    return 0;
  },
};
