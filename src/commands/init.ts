/**
 * `ideaspaces init <name>` — create a new space and clone it locally
 * with git user.email / user.name wired to the OAuth account.
 *
 * Replaces the pre-git-push pattern of `ideaspaces sync` (file-by-file
 * upload) and `ideaspaces power connect --from-cwd`. The space on the
 * server is now the origin; local git is just a working copy.
 *
 * Flow:
 *   1. Read stored credentials (requires `ideaspaces login`).
 *   2. Fetch /auth/me for the OAuth email + name.
 *   3. createRepo on the server — scaffolds _agent/, README, etc.
 *   4. git clone the resulting space into ./<slug> (or --dir).
 *   5. git config --local user.email/user.name in the cloned dir so
 *      pushed commits resolve to person:<username> via the server's
 *      DB email lookup — no trailer workaround, no identity mismatch.
 *   6. Save repo_id to credentials so other CLI commands target it.
 */

import { createClient } from "@ideaspaces/sdk";
import { execFileSync, spawn } from "node:child_process";
import { loadConfig, saveCredentials } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

interface AuthMe {
  user_id: number;
  username: string | null;
  email: string | null;
  name: string | null;
}

async function fetchAuthMe(config: { apiKey: string; apiUrl: string }): Promise<AuthMe> {
  const resp = await fetch(`${config.apiUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`/auth/me returned ${resp.status} — try 'ideaspaces login' again`);
  }
  return (await resp.json()) as AuthMe;
}

function gitUrlFor(namespace: string, slug: string): string {
  const base = (process.env.IS_GIT_URL || "https://git.ideaspaces.xyz").replace(/\/+$/, "");
  return `${base}/${namespace}/${slug}.git`;
}

function spawnGit(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { stdio: "inherit" });
    proc.on("error", () => resolve(1));
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

function configureLocalGit(cwd: string, email: string, name: string): void {
  // Set identity per-repo so other projects' global config isn't touched.
  // git config --local writes to the repo's own .git/config file. Setting
  // user.email here is the whole point of `init` beyond what `power create`
  // already did — makes `person:<username>` resolve on every commit pushed
  // from this clone, no trailer needed.
  execFileSync("git", ["config", "--local", "user.email", email], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "--local", "user.name", name], { cwd, stdio: "ignore" });
}

export const initCommand: CommandDef = {
  name: "init",
  description: "Create a new space and clone it locally with git identity wired up",
  usage:
    "ideaspaces init <name> [--slug SLUG] [--hostname HOST] [--purpose PURPOSE] [--dir DIR]",
  examples: [
    "ideaspaces init 'My Notes'",
    "ideaspaces init 'Team Research' --hostname acme.com",
    "ideaspaces init 'Architecture' --slug arch --dir ./arch-space",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run: ideaspaces login");
      return 2;
    }

    const name = args[0]?.trim();
    if (!name) {
      output.error("Name required. Usage: ideaspaces init <name>");
      return 1;
    }

    const slug = (flags.slug as string | undefined) || undefined;
    const hostname = (flags.hostname as string | undefined) || undefined;
    const purpose = (flags.purpose as string | undefined) || undefined;
    const dirFlag = (flags.dir as string | undefined) || undefined;

    // Fetch OAuth identity BEFORE creating the space. If /auth/me fails,
    // we haven't side-effected the server yet — cleaner failure state
    // than creating a space then bailing.
    let me: AuthMe;
    try {
      me = await fetchAuthMe(config);
    } catch (e) {
      output.error(e instanceof Error ? e.message : String(e));
      return 1;
    }

    if (!me.email) {
      output.error(
        "Your account has no email recorded. Re-login to refresh, then retry.",
      );
      return 1;
    }

    const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });

    output.progress(`Creating space "${name}"...`);
    const { data: repo } = await client.createRepo({ name, slug, purpose });

    // Resolve namespace for the clone URL:
    //  - hostname-scoped repo (e.g. created via --hostname) → namespace = hostname
    //  - personal repo → namespace = the user's handle
    // The server decides based on whether `hostname` was supplied; we mirror
    // that logic here so we can build the URL without a second round-trip.
    const namespace = hostname || me.username;
    if (!namespace) {
      output.error(
        "Could not resolve namespace (username missing from account). " +
          "Complete onboarding at ideaspaces.xyz and retry.",
      );
      return 1;
    }

    const gitUrl = gitUrlFor(namespace, repo.slug);
    const targetDir = dirFlag || repo.slug;

    output.progress(`$ git clone ${gitUrl} ${targetDir}`);
    const cloneExit = await spawnGit(["clone", gitUrl, targetDir]);
    if (cloneExit !== 0) {
      output.error(`git clone failed (exit ${cloneExit}) — space was created on the server.`);
      return cloneExit;
    }

    try {
      configureLocalGit(targetDir, me.email, me.name || me.username || me.email);
    } catch (e) {
      // Non-fatal: the clone succeeded, identity config is recoverable by
      // running `git config --local user.email ...` manually.
      output.log(
        `warning: failed to set local git identity (${e instanceof Error ? e.message : e}). ` +
          `Run 'git config --local user.email ${me.email}' inside ${targetDir}.`,
      );
    }

    if (!process.env.IS_API_KEY) {
      saveCredentials({
        api_url: config.apiUrl,
        api_key: config.apiKey,
        repo_id: repo.repo_id,
      });
    }

    output.result(
      {
        repo_id: repo.repo_id,
        slug: repo.slug,
        name: repo.name,
        namespace,
        git_url: gitUrl,
        directory: targetDir,
        identity: { email: me.email, name: me.name || me.username || me.email },
      },
      [
        `Space created: ${repo.name} (${repo.slug})`,
        `Cloned to: ${targetDir}`,
        `Git identity: ${me.name || me.username} <${me.email}>`,
        "",
        `Next: cd ${targetDir}`,
      ].join("\n"),
    );
    return 0;
  },
};
