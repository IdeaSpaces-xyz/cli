/**
 * `ideaspaces publish --yes --json --token-fd <n>` under `IDEASPACES_AUTH=host`: an app publishes the folder it runs in,
 * on the person's sign-in it passes once on a descriptor. The Desktop's "publish privately".
 *
 * What differs from a terminal publish, and why:
 * - **The sign-in** is only the host's token (`hostedConfig`), never credentials.json or IS_API_KEY.
 * - **`~/.ideaspaces` is left alone**: no registry read or write. A folder is published once it has the canonical origin
 *   for its committed `root_node_id`; publishing it again answers `already` and pushes nothing.
 * - **The push** is the one place the token leaves this process, as Security set it out (v23 msg_6efa619b):
 *   - one `git push` to the explicit https URL built from the server's `root_node_id`, never a remote name;
 *   - the header in `GIT_CONFIG_KEY/VALUE` as `http.<that URL>.extraHeader`, never in argv or a file;
 *   - refused if the folder's effective config has `url.*.insteadOf` or `pushInsteadOf`, which could send it elsewhere;
 *   - global and system config off, hooks and fsmonitor off, no credential helper, no prompt, no trace variables.
 * - **Identity is added, never rewritten**: when the tip's author isn't the person, one empty commit goes on top under the
 *   person's IdeaSpaces identity, so the pre-receive check passes. Nothing is amended and the folder's `user.*` stays.
 * - **Private**: a new repo is private until it's shared. It goes with its whole history.
 *
 * Every answer is one JSON object on stdout: the result, or `ideaspaces.hosted.error.v1` with a `state` and a `code` an app
 * can word for itself. The terminal's `publish` is unchanged.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createRepo, fetchAuthMe, UnauthorizedError, ApiStatusError } from "../auth/api.js";
import { hostedConfig, HostAuthRefusal } from "../auth/credentials.js";
import { identityEmail, identityName } from "../auth/identity.js";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";
import { canonicalGitUrl, canonicalRepoUrl } from "../repo-locator.js";
import { inspectLocalRootIdentity } from "../root-identity.js";

/** Why a host publish stopped. `state` is the hosted verbs' failure set; `code` says which refusal it was. */
export type HostPublishCode =
  | "not_git" | "not_main" | "no_commits" | "identity" | "origin" | "too_large" | "frontmatter" | "no_username"
  | "subscription" | "redirected" | "push_refused" | "signed_out" | "expired" | "offline" | "unavailable" | "not_confirmed";

export interface HostPublishChecks {
  /** Tracked files over the server's blob cap; empty when none. */
  sizeOffenders(cwd: string): Array<{ path: string; bytes: number }>;
  /** A frontmatter problem in words, or null. */
  frontmatterProblem(cwd: string): Promise<string | null>;
  /** A root identity problem in words, or null. */
  identityProblem(identity: ReturnType<typeof inspectLocalRootIdentity>): string | null;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(gitBinary(), ["-C", cwd, ...args], { encoding: "utf-8", ...(env ? { env } : {}) });
  if (r.error) return { ok: false, stdout: "", stderr: r.error.message, status: null };
  return { ok: r.status === 0, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), status: r.status };
}

/**
 * The environment of a Git child that must not be steered by anything but this call: no global or system config, no
 * credential helper, hooks or fsmonitor, no prompt, no trace. `extra` adds config pairs on top, by GIT_CONFIG_COUNT.
 */
export function isolatedGitEnv(extra: Array<[string, string]> = []): NodeJS.ProcessEnv {
  const env = sanitizedGitEnvironment();
  // An app's own Git keeps what it runs by (GIT_EXEC_PATH, GIT_SSL_CAINFO, GIT_TEMPLATE_DIR); what could watch, prompt,
  // redirect or loosen a push goes.
  for (const key of Object.keys(env)) {
    if (/^GIT_(TRACE|CURL_VERBOSE|ASKPASS|SSH|PROXY|SSL_NO_VERIFY|CONFIG$|CONFIG_PARAMETERS|CONFIG_SYSTEM|REDIRECT)/.test(key) || key === "SSH_ASKPASS") delete env[key];
  }
  const pairs: Array<[string, string]> = [["credential.helper", ""], ["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["protocol.allow", "never"], ["protocol.https.allow", "always"], ...extra];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_COUNT: String(pairs.length),
    ...Object.fromEntries(pairs.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
  };
}

/** The effective `insteadOf`/`pushInsteadOf` rewrites in this folder, as the push child would read them. */
export function urlRewrites(cwd: string): string[] {
  const r = git(cwd, ["config", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], isolatedGitEnv());
  return r.ok && r.stdout ? r.stdout.split("\n").filter(Boolean) : [];
}

export async function publishInHost(cwd: string, flags: { name?: string }, checks: HostPublishChecks): Promise<number> {
  const answer = (data: unknown) => { process.stdout.write(`${JSON.stringify(data, null, 2)}\n`); return 0; };
  const fail = (code: HostPublishCode, state: string, message: string) => {
    process.stdout.write(`${JSON.stringify({ schema: "ideaspaces.hosted.error.v1", error: { state, code, message } }, null, 2)}\n`);
    process.stderr.write(`${message}\n`);
    return 1;
  };

  // The Git service is the host's, beside its API: never an IS_GIT_URL override from the environment.
  delete process.env.IS_GIT_URL;
  let config;
  try { config = hostedConfig("Publishing"); }
  catch (err) { return fail("signed_out", "signed_out", err instanceof HostAuthRefusal ? err.message : "No sign-in was passed."); }

  if (!existsSync(join(cwd, ".git"))) return fail("not_git", "invalid_request", "This folder isn't a Git repository yet.");
  const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch.ok || branch.stdout !== "main") return fail("not_main", "invalid_request", "This folder's branch isn't main, which IdeaSpaces publishes.");
  if (!git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) return fail("no_commits", "invalid_request", "This folder has nothing committed to publish.");

  let identity: ReturnType<typeof inspectLocalRootIdentity>;
  try { identity = inspectLocalRootIdentity(cwd, config.apiUrl); }
  catch { return fail("identity", "invalid_request", "This folder's identity couldn't be read."); }
  const problem = checks.identityProblem(identity);
  if (problem) return fail("identity", "invalid_request", problem);

  // Already published: the canonical origin for the committed identity. Nothing is pushed here; keeping it current is sync's.
  if (identity.origin_url) {
    if (identity.canonical_origin && identity.root_node_id && identity.canonical_origin === identity.root_node_id)
      return answer({ status: "already", root_node_id: identity.root_node_id, repo_url: canonicalRepoUrl(config.apiUrl, identity.root_node_id) });
    return fail("origin", "conflict", "This folder already has a Git origin that isn't its IdeaSpaces home, so it isn't published again.");
  }

  const big = checks.sizeOffenders(cwd);
  if (big.length) return fail("too_large", "invalid_request", `${big.length} file${big.length === 1 ? " is" : "s are"} over IdeaSpaces' 200 KB limit: ${big.slice(0, 3).map((o) => o.path).join(", ")}.`);
  const frontmatter = await checks.frontmatterProblem(cwd);
  if (frontmatter) return fail("frontmatter", "invalid_request", "Some Notes have frontmatter IdeaSpaces can't read. Fix it, commit, and publish again.");
  if (urlRewrites(cwd).length) return fail("redirected", "invalid_request", "This folder's Git config rewrites URLs (insteadOf), which could send the push elsewhere. Nothing was published.");

  let me;
  try { me = await fetchAuthMe(config); }
  catch (err) {
    if (err instanceof UnauthorizedError) return fail("expired", "expired", "The sign-in was refused.");
    return fail("offline", "offline", "IdeaSpaces couldn't be reached.");
  }
  if (!me.username) return fail("no_username", "invalid_request", "This account has no username yet.");

  const committedId = typeof identity.declaration.head === "string" ? identity.declaration.head : undefined;
  let repo;
  try {
    repo = await createRepo(config, { name: flags.name?.toString() || basename(cwd), ...(committedId ? { root_node_id: committedId } : {}) }, { statusError: true });
  } catch (err) {
    if (err instanceof ApiStatusError) {
      if (err.status === 402) return fail("subscription", "forbidden", "Publishing needs a publishing plan.");
      if (err.status === 401) return fail("expired", "expired", "The sign-in was refused.");
      if (err.status === 409) return fail("identity", "conflict", "IdeaSpaces already has a repository with this folder's identity.");
      return fail("unavailable", err.status === 429 ? "rate_limited" : "unavailable", `IdeaSpaces refused to create the repository (${err.status}).`);
    }
    return fail("offline", "offline", "IdeaSpaces couldn't be reached.");
  }
  if (!repo?.root_node_id || (committedId && repo.root_node_id !== committedId))
    return fail("identity", "conflict", "IdeaSpaces didn't keep this folder's identity. Nothing was pushed.");

  // The pre-receive check reads the tip's author. Add, never rewrite: one empty commit under the person, if needed.
  const email = identityEmail(me.username);
  const tip = git(cwd, ["log", "-1", "--format=%ae"]);
  let added = false;
  if (tip.stdout !== email) {
    const commit = git(cwd, ["-c", `user.email=${email}`, "-c", `user.name=${identityName({ name: me.name, username: me.username })}`, "-c", "commit.gpgsign=false",
      "commit", "--allow-empty", "--no-verify", "-q", "-m", "Published to IdeaSpaces"], isolatedGitEnv());
    if (!commit.ok) return fail("push_refused", "invalid_request", "The publishing commit couldn't be made. Nothing was pushed.");
    added = true;
  }

  const url = canonicalGitUrl(config.apiUrl, repo.root_node_id);
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url))
    return fail("redirected", "invalid_request", "IdeaSpaces' Git address isn't https. Nothing was pushed.");
  const basic = Buffer.from(`ideaspaces:${config.apiKey}`).toString("base64");
  // A loopback test service speaks http; nothing else may.
  const loopback = url.startsWith("http://") ? [["protocol.http.allow", "always"] as [string, string]] : [];
  const push = git(cwd, ["push", "--no-verify", "--porcelain", url, "HEAD:refs/heads/main"], isolatedGitEnv([...loopback, [`http.${url}.extraHeader`, `Authorization: Basic ${basic}`]]));
  if (!push.ok) {
    const tooBig = /size cap|too large|exceeds/i.test(push.stderr);
    return fail(tooBig ? "too_large" : "push_refused", "invalid_request", tooBig ? "A file is over IdeaSpaces' 200 KB limit." : "IdeaSpaces refused the push.");
  }
  // The remote carries no credential: the next push asks the host again.
  git(cwd, ["remote", "add", "origin", url]);
  git(cwd, ["config", "branch.main.remote", "origin"]);
  git(cwd, ["config", "branch.main.merge", "refs/heads/main"]);
  return answer({ status: "published", private: true, with_history: true, root_node_id: repo.root_node_id, repo_id: repo.repo_id, name: repo.name,
    repo_url: canonicalRepoUrl(config.apiUrl, repo.root_node_id), commit_added: added });
}
