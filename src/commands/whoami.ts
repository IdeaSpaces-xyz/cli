import { loadConfig, loadStoredCredentials, saveCredentials } from "../auth/credentials.js";
import { fetchAuthMe } from "../auth/api.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const whoamiCommand: CommandDef = {
  name: "whoami",
  description: "Show login state — whether credentials are present, the API URL, and the account handle",
  usage: "ideaspaces whoami [--json]",
  examples: [
    "ideaspaces whoami",
    "ideaspaces whoami --json",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const config = loadConfig();

    if (!config) {
      output.result({ logged_in: false }, "Not logged in. Run `ideaspaces login`.");
      return 0;
    }

    // The handle is cached at login. Creds saved before that carry none — backfill
    // it once, best-effort: an offline call still succeeds, just without the handle.
    let username = config.username ?? null;
    if (!username) {
      try {
        const me = await fetchAuthMe(config);
        username = me.username ?? null;
        const stored = loadStoredCredentials();
        if (username && stored) {
          saveCredentials({ ...stored, username });
        }
      } catch {
        // Offline or transient — report logged-in without the handle.
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
