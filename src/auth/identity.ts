import { fetchAuthMe } from "./api.js";
import { loadStoredCredentials } from "./credentials.js";
import { localConfig, setLocalConfig } from "../git.js";

/** Format the IdeaSpaces email-identity for a given username.
 *
 * The pre-receive hook recognizes `person:<username>@ideaspaces` via
 * `_IDENTITY_EMAIL_RE` without a DB lookup. Single source of truth so
 * `create` (Layer 1) and `publish` (Layer 2) can't drift on the format.
 */
export function identityEmail(username: string): string {
  return `person:${username}@ideaspaces`;
}

/** True when an email is already an IdeaSpaces identity. */
const isIdentityEmail = (email: string): boolean => /^person:.+@ideaspaces$/.test(email);

/**
 * Ensure a clone's local `user.email` is the OAuth identity, so commits made in
 * it pass the server's attribution pre-receive hook (which otherwise rejects the
 * ambient `git config user.email`, e.g. a default `test@example.com`).
 *
 * Offline-safe and cheap: a no-op when the local email is already an identity,
 * so only the first commit in a pre-existing clone pays a short network call.
 * Fire-and-forget — never blocks the commit; a genuine mismatch still surfaces
 * at push time with the server's guidance.
 */
export async function ensureLocalIdentity(repoDir: string): Promise<void> {
  try {
    const current = localConfig("user.email", repoDir);
    if (current && isIdentityEmail(current)) return;
    const stored = loadStoredCredentials();
    if (!stored) return;
    const me = await fetchAuthMe(
      { apiUrl: stored.api_url, apiKey: stored.api_key },
      { timeoutMs: 2000 },
    );
    if (!me.username) return;
    setLocalConfig("user.email", identityEmail(me.username), repoDir);
  } catch {
    // Don't block on transient auth/network/git failure.
  }
}
