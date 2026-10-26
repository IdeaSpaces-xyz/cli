import { loadConfig, loadStoredCredentials, saveCredentials, withCredentialsLock } from "../auth/credentials.js";
import { fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import { cacheSessionUsername, SessionAuthError } from "../auth/client-session.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const whoamiCommand: CommandDef = {
  name: "whoami",
  description: "Show login state — legacy name for `status account`",
  usage: "ideaspaces status account [--json]  (legacy: ideaspaces whoami)",
  examples: [
    "ideaspaces status account",
    "ideaspaces status account --json",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const config = loadConfig();

    if (!config) {
      output.result({ logged_in: false }, "Not logged in. Run `ideaspaces login`.");
      return 0;
    }

    if (config.sessionId) {
      try {
        const me = await fetchAuthMe(config);
        if (me.username) await cacheSessionUsername(config, me.username);
        output.result({ logged_in: true, api_url: config.apiUrl, username: me.username ?? null }, `Logged in to ${config.apiUrl}${me.username ? ` as @${me.username}` : ""}.`);
        return 0;
      } catch (error) {
        if (error instanceof UnauthorizedError || error instanceof SessionAuthError) {
          output.result({ logged_in: false }, "Not signed in. Run `ideaspaces login`.");
          return 0;
        }
        const detail = error instanceof Error ? error.message : "The sign-in check failed.";
        output.error(`${detail} Could not verify this sign-in; local credentials were kept. Resolve the cause and retry.`);
        return 1;
      }
    }

    // The handle is cached at login. Creds saved before that carry none — backfill
    // it once, best-effort. Only when there's an on-disk credentials file to cache
    // into: env-key auth (IS_API_KEY / CI) has none, so a fetch there would round-
    // trip on every call for nothing — keep whoami instant for that audience.
    let username = config.username ?? null;
    if (!username) {
      const stored = loadStoredCredentials();
      if (stored) {
        output.progress("Checking account handle…");
        try {
          const me = await fetchAuthMe(config);
          username = me.username ?? null;
          if (username) await withCredentialsLock(async () => {
            const current = loadStoredCredentials();
            if (current && !current.session && current.api_key === stored.api_key && current.api_url === stored.api_url) saveCredentials({ ...current, username });
          });
        } catch {
          // Offline or transient — report logged-in without the handle.
        }
      }
    }

    // Never emit the API key — only whether we're logged in, where, and as whom.
    output.result(
      { logged_in: true, api_url: config.apiUrl, username },
      `Logged in to ${config.apiUrl}${username ? ` as @${username}` : ""}.`,
    );
    return 0;
  },
};
