/**
 * Git credential helper integration.
 *
 * Registers `ideaspaces credential` as the git credential helper for
 * ideaspaces.xyz git hosts, so `git clone` transparently picks up the
 * user's API key after `ideaspaces login`.
 *
 * Scope: limited to ideaspaces hosts via `credential.<url>.helper`.
 * Will not affect GitHub, GitLab, or any other git remote.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Hosts for which we want our credential helper. The credential helper
// config key uses the URL form `credential.<url>.helper` so git only
// invokes us for matching hosts.
const GIT_HOSTS = [
  "https://git.ideaspaces.xyz",
  "https://git.ideaspaces.localhost",
];

/**
 * Register `ideaspaces credential` as git credential helper for our hosts.
 *
 * Idempotent — safe to call on every login. Best-effort: if git isn't
 * installed or the config write fails, we swallow the error (user can
 * always type their API key manually if prompted).
 */
export async function registerGitCredentialHelper(): Promise<void> {
  for (const host of GIT_HOSTS) {
    try {
      await execAsync(
        `git config --global credential.${host}.helper "!ideaspaces credential"`,
      );
    } catch {
      // Git not installed, or config write failed — silently skip.
      // User can register manually: `git config --global credential.<host>.helper "!ideaspaces credential"`.
    }
  }
}
