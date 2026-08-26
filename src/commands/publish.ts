/**
 * `ideaspaces publish` — host this folder as a remote ideaspace.
 *
 * Flow:
 *   1. Load credentials (require login).
 *   2. Fetch /auth/me for the OAuth-resolved username.
 *   3. Evaluate committed foundation, canonical origin, and local registry;
 *      refuse dirty, drifted, ambiguous, or incompatible identity evidence.
 *   4. POST /repos with the committed root_node_id for atomic adoption.
 *   5. Set local git user.email = person:<username>@ideaspaces in cwd so
 *      the pre-receive identity check resolves the author without needing
 *      a Co-authored-by trailer per commit.
 *   6. git remote add origin → git push -u origin main. The server's bare
 *      repo accepts the ref creation; force-push guard short-circuits on
 *      ZERO_OID for new refs.
 *   7. Persist stable root identity plus route projection to
 *      ~/.ideaspaces/spaces.json, keyed by absolute folder path.
 *
 * Pre-receive enforces a 200KB per-blob size cap and identity strict-match
 * on the tip commit. Local git config picks up the identity automatically;
 * size cap surfaces as a structured rejection if a blob is too large.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createOutput } from "../output.js";
import { getDefaultApiUrl, loadConfig, loadStoredCredentials } from "../auth/credentials.js";
import { fetchAuthMe, createRepo, deriveGitBase, deriveWebBase, UnauthorizedError } from "../auth/api.js";
import {
  findSpaceFor,
  isHostedSpaceRecord,
  isUnpublishedForkRecord,
  saveSpace,
  withForkLineage,
  type HostedSpaceRecord,
} from "../auth/spaces.js";
import {
  canonicalGitUrl,
  canonicalSpaceUrl,
  spaceRecordForRepo,
} from "../space-locator.js";
import {
  identityEmail as formatIdentityEmail,
  identityName as formatIdentityName,
} from "../auth/identity.js";
import { normalizeRepoUrl } from "../git.js";
import {
  inspectLocalRootIdentity,
  type LocalRootIdentityReport,
} from "../root-identity.js";
import type { CommandDef } from "../types.js";
import {
  hasFrontmatterSyntaxProblems,
  renderFrontmatterSyntaxProblems,
  scanMarkdownFrontmatterSyntaxFiles,
} from "../frontmatter-report.js";

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

function legacyGitUrl(apiUrl: string, namespace: string, slug: string): string {
  return `${deriveGitBase(apiUrl)}/${namespace}/${slug}.git`;
}

function legacyWebUrl(apiUrl: string, namespace: string, slug: string): string {
  return `${deriveWebBase(apiUrl)}/${namespace}/${slug}`;
}

const SIZE_CAP_BYTES = 200_000;
const SIZE_CAP_MARKERS = ["size cap", "too large", "exceeds"];

interface SizeOffender {
  path: string;
  bytes: number;
}

export function preflightSize(cwd: string): SizeOffender[] {
  const r = spawnSync("git", ["-C", cwd, "ls-files", "-z"], { encoding: "utf-8" });
  if (r.error) throw new Error(`git not available: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(r.stderr.trim() || "git ls-files failed while checking blob sizes");
  }
  const offenders: SizeOffender[] = [];
  for (const rel of r.stdout.split("\0").filter(Boolean)) {
    const abs = join(cwd, rel);
    let bytes: number;
    try {
      bytes = statSync(abs).size;
    } catch {
      // ls-files lists tracked paths from the index; the working tree may
      // be missing one (deleted but not staged). Skip — the push will
      // surface any real index/server mismatch.
      continue;
    }
    // Server rejects with "blobs over 200,000 bytes rejected" — strict
    // greater-than. A file at exactly the cap passes both client and server.
    if (bytes > SIZE_CAP_BYTES) offenders.push({ path: rel, bytes });
  }
  return offenders;
}

export function renderSizeProblems(offenders: SizeOffender[]): string {
  const noun = offenders.length === 1 ? "file" : "files";
  return [
    `Cannot publish yet: ${offenders.length} tracked ${noun} exceed the ${SIZE_CAP_BYTES.toLocaleString("en-US")}-byte server limit.`,
    "",
    ...offenders.map((o) => `  ${o.path} (${o.bytes.toLocaleString("en-US")} bytes)`),
    "",
    "Fix: add the offending paths to `.gitignore` (especially vault config",
    "like `.obsidian/`), untrack with `git rm --cached -r <path>`, commit,",
    "and retry publish. Or shrink the file, store it externally, and link",
    "it via frontmatter (`attached_to:`).",
  ].join("\n");
}

const SESSION_EXPIRED_MSG =
  "Your IdeaSpaces session has expired. Run `ideaspaces login` to refresh, then retry publish.";

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

function rootIdentityProblem(identity: LocalRootIdentityReport): string | null {
  if (identity.declaration.dirty) {
    return (
      "The root identity declaration differs between HEAD, the index, and the worktree. " +
      "Publish sends HEAD; commit or restore _agent/foundation.md before publishing."
    );
  }
  if (identity.state === "invalid") {
    return "Root identity evidence is invalid. Fix the foundation declaration before publishing.";
  }
  if (identity.state === "drift") {
    return "Root identity drift: the committed foundation disagrees with the hosted origin or local registry. Refusing to rebind or rekey the Space.";
  }
  if (identity.state === "ambiguous") {
    return "Root identity is ambiguous: the canonical origin and local registry name different Spaces. Refusing to choose one.";
  }
  return null;
}

function sameRemote(left: string, right: string): boolean {
  const leftKey = normalizeRepoUrl(left);
  const rightKey = normalizeRepoUrl(right);
  if (leftKey !== null || rightKey !== null) return leftKey !== null && leftKey === rightKey;
  // Local file:// remotes are used by package tests and self-hosted workflows;
  // they have no hostname, so the general remote normalizer intentionally
  // declines them. Compare their stable lexical form instead.
  const lexical = (value: string) => value.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  return lexical(left) === lexical(right);
}

async function checkMarkdownFrontmatterSyntax(cwd: string): Promise<string | null> {
  const files = trackedMarkdownFiles(cwd);
  if (!files.length) return null;

  const syntaxScan = await scanMarkdownFrontmatterSyntaxFiles(files);
  if (!hasFrontmatterSyntaxProblems(syntaxScan)) return null;

  return renderFrontmatterSyntaxProblems(syntaxScan, {
    cwd,
    header: [
      "Cannot publish yet: markdown frontmatter is invalid.",
      "Fix YAML syntax before publishing so the server can index these files.",
      "",
    ],
    footer: ["Fix YAML first, commit the repair, and re-run `ideaspaces publish`."],
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
  description: "Publish this folder as a remote ideaspace",
  usage: "ideaspaces publish [--slug <slug>] [--name <name>] [--hostname <host>]",
  examples: [
    "ideaspaces publish                     # publish current directory",
    "ideaspaces publish --slug my-notes     # explicit slug",
    "ideaspaces publish --hostname acme.com # publish into an org space (must be a member)",
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

    const existing = findSpaceFor(cwd);
    const hosted = existing && isHostedSpaceRecord(existing) ? existing : null;
    const unpublished = existing && isUnpublishedForkRecord(existing) ? existing : null;
    let rootIdentity: LocalRootIdentityReport;
    try {
      rootIdentity = inspectLocalRootIdentity(cwd, loadConfig()?.apiUrl);
    } catch (err) {
      output.error(`Could not inspect Space identity: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const identityProblem = rootIdentityProblem(rootIdentity);
    if (identityProblem) {
      output.error(identityProblem);
      return 1;
    }

    // Force may retry replaceable delivery state, but it never changes which
    // Space this checkout is. A new identity requires an explicit local Fork
    // and a separate destination checkout.
    if (hosted && flags.force) {
      output.error(
        `This folder is already bound to Space ${rootIdentity.root_node_id ?? hosted.root_node_id ?? hosted.repo_id}. ` +
          "`publish --force` cannot fork or rekey it. Create a local Fork in a separate destination and publish that checkout instead.",
      );
      return 1;
    }

    const currentOrigin = rootIdentity.origin_url;
    if (unpublished && currentOrigin) {
      output.error(
        `This registry entry is unpublished, but git already has origin ${currentOrigin}. ` +
          "Refusing to infer or replace a destination. If the remote is accidental, remove it with " +
          "`git remote remove origin`; if this folder is already hosted, run `ideaspaces forget .` " +
          "then `ideaspaces link . <space>`.",
      );
      return 1;
    }
    if (hosted && currentOrigin) {
      const apiUrl = loadConfig()?.apiUrl ?? getDefaultApiUrl();
      const compatibleRemotes = [
        rootIdentity.root_node_id ? canonicalGitUrl(apiUrl, rootIdentity.root_node_id) : null,
        legacyGitUrl(apiUrl, hosted.namespace, hosted.slug),
      ].filter((value): value is string => value !== null);
      if (!compatibleRemotes.some((candidate) => sameRemote(currentOrigin, candidate))) {
        output.error(
          `Origin ${currentOrigin} is incompatible with the local registry binding for ${hosted.namespace}/${hosted.slug}. ` +
            "Refusing to replace it during publish; restore the matching origin or use an explicit local Fork.",
        );
        return 1;
      }
    }
    if (!hosted && !unpublished && currentOrigin) {
      output.error(
        rootIdentity.canonical_origin
          ? `This checkout already has canonical origin ${currentOrigin}. Link it to that hosted Space instead of publishing a second destination.`
          : `This checkout already has origin ${currentOrigin}. Refusing to replace an unrelated remote during publish.`,
      );
      return 1;
    }

    // Size preflight first — fail-fast on tracked files exceeding the
    // server's 200KB blob cap. Cheap (stat only), and a positive hit
    // usually means a clutter dir (.obsidian/, node_modules/) that the
    // user wants to untrack before bothering with markdown work.
    let sizeOffenders: SizeOffender[];
    try {
      sizeOffenders = preflightSize(cwd);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (sizeOffenders.length) {
      output.error(renderSizeProblems(sizeOffenders));
      return 1;
    }

    let frontmatterProblem: string | null;
    try {
      frontmatterProblem = await checkMarkdownFrontmatterSyntax(cwd);
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (frontmatterProblem) {
      output.error(frontmatterProblem);
      return 1;
    }

    const stored = loadStoredCredentials();
    if (!stored) {
      output.error("Not logged in. Run `ideaspaces login` first.");
      return 1;
    }
    const config = { apiUrl: stored.api_url, apiKey: stored.api_key };
    if (unpublished && rootIdentity.declaration.head !== unpublished.root_node_id) {
      output.error(
        `The unpublished registry identity (${unpublished.root_node_id}) requires the same committed ` +
          "root _agent/foundation.md declaration before publishing.",
      );
      return 1;
    }

    let me;
    try {
      me = await fetchAuthMe(config);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error(SESSION_EXPIRED_MSG);
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
    let repo: { repo_id: string; root_node_id?: string; slug: string; name: string };
    let namespace: string;

    if (hosted) {
      // Stale-mapping detection — `/auth/me` returns the repos this user
      // can see. If the mapped repo_id isn't there, either the remote was
      // deleted or the user lost access. Both surface identically; push
      // would otherwise hit git's opaque "Repository not found".
      // Note: this assumes `/auth/me` returns the full repo set (no
      // pagination). Safe today; revisit if the endpoint adds paging.
      const stillVisible = me.repos.some((r) => r.repo_id === hosted.repo_id);
      if (!stillVisible) {
        output.error(
          `This folder is mapped to ${hosted.namespace}/${hosted.slug} ` +
            `(repo_id=${hosted.repo_id}) but that remote no longer exists ` +
            `or you no longer have access to it. Identity cannot be moved to a fresh remote. ` +
            `Restore access or repair the binding; to publish as a new Space, create an explicit ` +
            `local Fork in a separate destination.`,
        );
        return 1;
      }

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
            `This folder is already mapped to ${hosted.namespace}/${hosted.slug}; ` +
            `re-publish reuses that identity. Create an explicit local Fork to publish as a new Space.`,
        );
        return 1;
      }

      output.log(
        `This folder is already published as ${hosted.namespace}/${hosted.slug} ` +
          `(repo_id=${hosted.repo_id}). Re-pushing to the same Space identity.`,
      );
      const projected = me.repos.find((candidate) => candidate.repo_id === hosted.repo_id);
      repo = {
        repo_id: hosted.repo_id,
        root_node_id: projected?.root_node_id ?? hosted.root_node_id ?? undefined,
        slug: hosted.slug,
        name: hosted.name ?? hosted.slug,
      };
      namespace = hosted.namespace;
    } else {
      const folderName = basename(cwd);
      const name = flags.name?.toString() || unpublished?.name || folderName;
      // Server enforces ^[a-z0-9][a-z0-9-]*$ on slug. If the user passes
      // --slug, trust them but still normalize so a casing slip doesn't
      // become a 422. Otherwise derive from the folder basename.
      const slugInput = flags.slug?.toString() || unpublished?.name || folderName;
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

      const prescribedRootNodeId =
        typeof rootIdentity.declaration.head === "string"
          ? rootIdentity.declaration.head
          : undefined;
      try {
        repo = await createRepo(config, {
          name,
          slug,
          hostname,
          ...(prescribedRootNodeId ? { root_node_id: prescribedRootNodeId } : {}),
        });
        if (prescribedRootNodeId && repo.root_node_id !== prescribedRootNodeId) {
          output.error(
            `The server returned ${repo.root_node_id || "no root identity"} instead of adopting ` +
              `${prescribedRootNodeId}. No remote was configured or pushed.`,
          );
          return 1;
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          output.error(SESSION_EXPIRED_MSG);
          return 1;
        }
        output.error(`Couldn't create remote space: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }

    // Identity wiring is complete and repo-local: later local-effect commits
    // consume these explicit values without reading credentials or the network.
    const identityEmail = formatIdentityEmail(me.username);
    const identityDisplayName = formatIdentityName({ name: me.name, username: me.username });
    const setEmail = runGit(cwd, ["config", "--local", "user.email", identityEmail]);
    const setName = runGit(cwd, ["config", "--local", "user.name", identityDisplayName]);
    if (!setEmail.ok || !setName.ok) {
      output.error(
        `git config local identity failed: ${setEmail.ok ? setName.stderr : setEmail.stderr}`,
      );
      return 1;
    }

    // First-publish only — amending already-pushed commits creates divergence.
    if (!hosted) {
      const tipAuthor = runGit(cwd, ["log", "-1", "--format=%ae"]);
      if (!tipAuthor.ok) {
        output.log("Could not read tip author; skipping author rewrite. If push fails the identity check, fix git history manually.");
      } else if (tipAuthor.stdout && tipAuthor.stdout !== identityEmail) {
        output.log(`Rewriting tip commit author to ${identityEmail} to satisfy the pre-receive identity check.`);
        // --reset-author is the simplest path: it picks up both user.email and
        // user.name from local config. Tradeoff: it also resets author-date to
        // now, so the commit timestamp jumps to publish time. Acceptable for
        // first-publish (the recovery case); the alternative (--author="N <e>")
        // would require knowing user.name and bypass the silent fall-through
        // when name isn't configured.
        const amend = runGit(cwd, ["commit", "--amend", "--no-edit", "--reset-author"]);
        if (!amend.ok) {
          // Two common failure modes: gpg signing without a configured key,
          // and missing user.name (CI envs that set EMAIL but not NAME).
          let hint = "";
          if (/gpg|signing|secret key/i.test(amend.stderr)) {
            hint = `\nIf you have commit signing on (\`commit.gpgsign=true\`), either configure a key for ${identityEmail} or run \`git config --local commit.gpgsign false\` in this dir.`;
          } else if (/please tell me who you are/i.test(amend.stderr)) {
            hint = `\nGit needs a \`user.name\` to commit. Run \`git config --local user.name "Your Name"\` and retry.`;
          }
          output.error(`git commit --amend failed: ${amend.stderr}${hint}`);
          return 1;
        }
      }
    }

    const remoteUrl = repo.root_node_id
      ? canonicalGitUrl(config.apiUrl, repo.root_node_id)
      : legacyGitUrl(config.apiUrl, namespace, repo.slug);
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

    let projected = me.repos.find((candidate) => candidate.repo_id === repo.repo_id);
    if (repo.root_node_id && !projected) {
      try {
        const refreshed = await fetchAuthMe(config);
        projected = refreshed.repos.find((candidate) => candidate.repo_id === repo.repo_id);
      } catch {
        output.log("Published successfully, but current route metadata could not be refreshed; stable Space identity was saved.");
      }
    }

    const hostedRecord: HostedSpaceRecord = projected
      ? spaceRecordForRepo(projected, me.username)
      : {
          repo_id: repo.repo_id,
          slug: repo.slug,
          namespace,
          ...(repo.root_node_id
            ? {
                root_node_id: repo.root_node_id,
                route_status: "unavailable" as const,
                route_namespace: null,
                route_slug: null,
                canonical_path: `/spaces/${repo.root_node_id}`,
              }
            : {}),
        };
    const record = withForkLineage(hostedRecord, existing);
    saveSpace(cwd, record);

    const webUrl = repo.root_node_id
      ? canonicalSpaceUrl(config.apiUrl, repo.root_node_id)
      : legacyWebUrl(config.apiUrl, namespace, repo.slug);
    output.result(
      {
        repo_id: repo.repo_id,
        root_node_id: repo.root_node_id ?? record.root_node_id ?? null,
        slug: repo.slug,
        namespace,
        route_status: record.route_status ?? null,
        route_namespace: record.route_namespace ?? null,
        route_slug: record.route_slug ?? null,
        remote_url: remoteUrl,
        space_url: webUrl,
        web_url: webUrl,
        identity_email: identityEmail,
        identity_state: repo.root_node_id ? "aligned" : rootIdentity.state,
      },
      [
        `Published ${repo.name}.`,
        `Space: ${webUrl}`,
        `Local git identity set to ${identityDisplayName} <${identityEmail}> (this dir only — your global git config is untouched).`,
      ].join("\n"),
    );
    return 0;
  },
};
