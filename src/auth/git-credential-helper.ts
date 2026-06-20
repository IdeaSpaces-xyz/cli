/**
 * Git credential helper integration.
 *
 * Registers this CLI as the git credential helper for ideaspaces.xyz git hosts,
 * so `git clone` / `git push` transparently picks up the user's API key after
 * `ideaspaces login`.
 *
 * Scope: limited to ideaspaces hosts via `credential.<url>.helper`.
 * Will not affect GitHub, GitLab, or any other git remote.
 *
 * Why the helper points at an ABSOLUTE path, not bare `ideaspaces`
 * ---------------------------------------------------------------
 * Git runs an `!`-prefixed helper through `sh -c`, which resolves the command
 * on PATH. When the CLI ships as the desktop's Tauri **sidecar** it lives inside
 * the app bundle (`…/Contents/MacOS/ideaspaces`) and is NOT on PATH — so a bare
 * `!ideaspaces credential` helper fails with *"ideaspaces: command not found"*
 * and git falls back to prompting for a username (which, with no TTY, dies as
 * *"could not read Username … Device not configured"*). We register the helper
 * with the absolute path to the running executable so git can always find it,
 * on PATH or not.
 *
 * Why we reset the helper chain before adding our own
 * --------------------------------------------------
 * Git evaluates credential helpers in list order and stops at the first one
 * that returns working credentials. Without a reset, URL-scoped helpers *append*
 * to global ones — on macOS that means `osxkeychain` (configured globally by
 * Xcode / Git for Mac) runs BEFORE our helper. If the keychain has stale creds
 * for `git.ideaspaces.xyz`, git returns them, the server rejects with 401/403,
 * and git surfaces the failure without ever consulting our helper.
 *
 * Git's escape hatch: an empty helper value (`credential.<url>.helper = ""`)
 * resets the chain for requests matching that URL. Setting an empty value
 * followed by our real helper gives us a single-entry chain scoped to
 * ideaspaces hosts: osxkeychain (and any other globally-registered helper)
 * stays in place for every OTHER host but is excluded for ours.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Hosts for which we want our credential helper. The credential helper config
// key uses the URL form `credential.<url>.helper` so git only invokes us for
// matching hosts.
const GIT_HOSTS = [
  "https://git.ideaspaces.xyz",
  "https://git.ideaspaces.localhost",
];

/**
 * Single-quote a value for the shell git runs the helper through (`!cmd` is
 * executed via `sh -c`). Wrap in single quotes; escape embedded single quotes
 * by closing, emitting an escaped quote, and reopening. Keeps paths with spaces
 * (e.g. an app bundle under "Application Support") intact.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The credential-helper command git stores and later runs via `sh -c`, using
 * the absolute path to THIS executable (see the file header for why bare
 * `ideaspaces` breaks under the desktop sidecar).
 *
 * Two runtimes:
 *   - a `bun --compile` standalone binary (our sidecar) embeds its entry under
 *     a virtual `$bunfs` path and `process.execPath` IS the binary — invoke it
 *     directly: `!'/abs/ideaspaces' credential`.
 *   - a JS entry under a runtime (node/bun in dev) — re-invoke
 *     `!'<runtime>' '<script>' credential`.
 */
function selfCredentialHelper(): string {
  const exe = process.execPath;
  const entry = process.argv[1];
  const compiled = !entry || entry.includes("$bunfs");
  const cmd = compiled ? shellQuote(exe) : `${shellQuote(exe)} ${shellQuote(entry)}`;
  return `!${cmd} credential`;
}

/**
 * Register this CLI as git credential helper for our hosts.
 *
 * Idempotent — safe to call on every login (and before each sync/clone, to
 * self-heal a stale path or a config written by an older version). Best-effort:
 * if git isn't installed or the config write fails, we swallow the error (the
 * user can always type their API key manually if prompted).
 *
 * Per host, writes the following at `--global` scope:
 *
 *     [credential "https://git.ideaspaces.xyz"]
 *         helper =
 *         helper = !'/abs/path/to/ideaspaces' credential
 *
 * The empty first entry resets the helper chain for this URL; the second entry
 * is ours. Global helpers (osxkeychain etc.) remain active for all other hosts.
 */
export async function registerGitCredentialHelper(): Promise<void> {
  const helper = selfCredentialHelper();
  for (const host of GIT_HOSTS) {
    try {
      const key = `credential.${host}.helper`;
      // Clear any previous value (an older CLI may have written a bare
      // `!ideaspaces credential`, or the path may have moved). --unset-all exits
      // non-zero when the key doesn't exist — ignore that.
      await execFileAsync("git", ["config", "--global", "--unset-all", key]).catch(() => {});
      // Empty sentinel resets the helper list for this URL…
      await execFileAsync("git", ["config", "--global", "--add", key, ""]);
      // …then our helper as the sole entry.
      await execFileAsync("git", ["config", "--global", "--add", key, helper]);
    } catch {
      // Git not installed, or config write failed — silently skip. The user can
      // register manually: git config --global credential.<host>.helper "!<path> credential".
    }
  }
}
