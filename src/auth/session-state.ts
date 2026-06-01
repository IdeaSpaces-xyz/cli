/**
 * Legacy session-state cleanup.
 *
 * The CLI used to keep its own per-repo last-seen HEAD in `~/.ideaspaces/
 * session.json`. That role now belongs to the SDK's `sessionState`
 * (`~/.ideaspaces/sessions/<repo>.json`), which is the single canonical store
 * for `lastSha` and the plugin's tracked capture paths — consumed by `status`,
 * `commit --tracked`, `sync`, and the SessionStart hook.
 *
 * Only `clearSessionState` remains, so `logout` still removes any stale
 * `session.json` left by older versions.
 */

import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_FILE = join(homedir(), ".ideaspaces", "session.json");

/** Remove the legacy `session.json` if present. */
export function clearSessionState(): void {
  try {
    if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
  } catch {
    // Ignore — best-effort cleanup.
  }
}
