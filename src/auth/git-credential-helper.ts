/**
 * Git credential helper integration.
 *
 * Registers `ideaspaces credential` as the git credential helper for
 * ideaspaces.xyz git hosts, so `git clone` / `git push` transparently
 * picks up the user's API key after `ideaspaces login`.
 *
 * Scope: limited to ideaspaces hosts via `credential.<url>.helper`.
 * Will not affect GitHub, GitLab, or any other git remote.
 *
 * Why we reset the helper chain before adding our own
 * --------------------------------------------------
 * Git evaluates credential helpers in list order and stops at the first
 * one that returns working credentials. Without a reset, URL-scoped
 * helpers *append* to global ones — on macOS that means `osxkeychain`
 * (configured globally by Xcode / Git for Mac) runs BEFORE our helper.
 * If the keychain has stale creds for `git.ideaspaces.xyz`, git returns
 * them, the server rejects with 401/403, and git surfaces the failure
 * without ever consulting our helper — even though our helper has the
 * fresh API key.
 *
 * Git's escape hatch: an empty helper value (`credential.<url>.helper = ""`)
 * resets the chain for requests matching that URL. Setting an empty value
 * followed by our real helper gives us a single-entry chain scoped to
 * ideaspaces hosts: osxkeychain (and any other globally-registered helper)
 * stays in place for every OTHER host but is excluded for ours.
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

const HELPER_VALUE = "!ideaspaces credential";

/**
 * Register `ideaspaces credential` as git credential helper for our hosts.
 *
 * Idempotent — safe to call on every login. Best-effort: if git isn't
 * installed or the config write fails, we swallow the error (user can
 * always type their API key manually if prompted).
 *
 * Per host, writes the following at `--global` scope:
 *
 *     [credential "https://git.ideaspaces.xyz"]
 *         helper =
 *         helper = !ideaspaces credential
 *
 * The empty first entry resets the helper chain for this URL; the second
 * entry is ours. Global helpers (osxkeychain etc.) remain active for all
 * other hosts.
 */
export async function registerGitCredentialHelper(): Promise<void> {
  for (const host of GIT_HOSTS) {
    try {
      const key = `credential.${host}.helper`;
      // Clear any previous value (the CLI may have written a single helper
      // in older versions; wipe that before re-adding with the reset).
      await execAsync(`git config --global --unset-all ${escapeShellArg(key)}`).catch(() => {
        // --unset-all exits non-zero when the key doesn't exist. Fine.
      });
      // `--add ""` writes an empty sentinel value that git interprets as
      // "reset the helper list for this URL."
      await execAsync(`git config --global --add ${escapeShellArg(key)} ""`);
      await execAsync(
        `git config --global --add ${escapeShellArg(key)} ${escapeShellArg(HELPER_VALUE)}`,
      );
    } catch {
      // Git not installed, or config write failed — silently skip.
      // User can register manually: `git config --global credential.<host>.helper "!ideaspaces credential"`.
    }
  }
}

function escapeShellArg(value: string): string {
  // Wrap in single quotes; escape any embedded single quote by closing,
  // emitting an escaped quote, and reopening. The inputs are all fixed
  // strings from our own code, but we stay strict anyway.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
