import { exec } from "node:child_process";
import { platform } from "node:os";
import { saveCredentials, getDefaultApiUrl } from "../auth/credentials.js";
import { startCallbackServer } from "../auth/callback-server.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import { deriveWebBase } from "../auth/api.js";
import type { CommandDef } from "../types.js";

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
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
    const authUrl = `${apiUrl}/auth/google?response_type=cli&port=${callbackServer.port}`;

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
