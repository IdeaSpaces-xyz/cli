import { exec } from "node:child_process";
import { platform } from "node:os";
import { saveCredentials, getDefaultApiUrl } from "../auth/credentials.js";
import { startCallbackServer } from "../auth/callback-server.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import { deriveWebBase, fetchAuthMe } from "../auth/api.js";
import type { CommandDef } from "../types.js";

export function buildCliLoginUrl(apiUrl: string, port: number): string {
  const url = new URL("/login", `${deriveWebBase(apiUrl)}/`);
  url.searchParams.set("response_type", "cli");
  url.searchParams.set("port", String(port));
  return url.toString();
}

export function openBrowser(url: string): void {
  if (platform() === "win32") {
    // `start`'s first quoted argument is the new console window's title, not the
    // target — `start "<url>"` opens an empty console and never launches anything.
    // The standard fix is an empty title placeholder: `start "" "<url>"`.
    exec(`start "" "${url}"`);
    return;
  }
  const cmd = platform() === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

export const loginCommand: CommandDef = {
  name: "login",
  description: "Log in to IdeaSpaces (optional — required for sync)",
  usage: "ideaspaces login",
  examples: [
    "ideaspaces login              # OAuth login; saves credentials for git push/pull",
  ],
  async run(_args, _flags, global) {
    const output = createOutput(global);

    const apiUrl = getDefaultApiUrl();
    const callbackServer = await startCallbackServer();
    const authUrl = buildCliLoginUrl(apiUrl, callbackServer.port);

    output.progress(`Opening browser for login...\n${authUrl}`);
    openBrowser(authUrl);

    let token: string;
    try {
      token = await callbackServer.waitForCallback(120_000);
      callbackServer.close();
    } catch (err) {
      callbackServer.close();
      output.error(err instanceof Error ? err.message : String(err));
      return 1;
    }

    saveCredentials({ api_url: apiUrl, api_key: token });
    // Cache the account handle so offline callers (e.g. `whoami`) can show who
    // you are without a round-trip. Best-effort: a failed fetch never fails login
    // — `whoami` backfills the handle on a later online call.
    try {
      const me = await fetchAuthMe({ apiUrl, apiKey: token });
      if (me.username) {
        saveCredentials({ api_url: apiUrl, api_key: token, username: me.username });
      }
    } catch {
      // Offline or transient — leave the handle uncached.
    }
    await registerGitCredentialHelper();

    const webUrl = deriveWebBase(apiUrl);
    output.result(
      { logged_in: true, web_url: webUrl },
      [
        "Logged in.",
        `View your account: ${webUrl}`,
        "`git push` / `git pull` against your space repos now picks up credentials automatically.",
      ].join("\n"),
    );
    return 0;
  },
};
