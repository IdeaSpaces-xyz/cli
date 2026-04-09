import { exec } from "node:child_process";
import { platform } from "node:os";
import { createClient, autoSelectRepo, createSession } from "@ideaspaces/sdk";
import { loadConfig, saveCredentials, getDefaultApiUrl } from "../auth/credentials.js";
import { startCallbackServer } from "../auth/callback-server.js";
import { formatRepoList, resolveRepo } from "../client.js";
import { createOutput } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

export const loginCommand: CommandDef = {
  name: "login",
  description: "Log in to IdeaSpaces or select a space",
  usage: "ideaspaces login [slug]",
  examples: [
    "ideaspaces login              # OAuth login, auto-select if one space",
    "ideaspaces login my-notes     # Select space by slug",
  ],
  async run(args, _flags, global) {
    const output = createOutput(global);
    const slug = args[0];

    // If slug provided and creds exist, just select the repo
    const config = loadConfig();
    if (slug && config) {
      const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });
      const { repos } = await autoSelectRepo(client);
      const match = resolveRepo(repos, slug);
      if (!match) {
        output.error(`Space "${slug}" not found. Available:\n${formatRepoList(repos)}`);
        return 4;
      }
      client.setRepo(match.repo_id);
      saveCredentials({ api_url: config.apiUrl, api_key: config.apiKey, repo_id: match.repo_id });

      // Orientation
      const session = createSession(client);
      let awareness = "";
      try { awareness = await session.getAwarenessBlock(); } catch { /* best effort */ }

      output.result(
        { space: match.slug, name: match.name, repo_id: match.repo_id },
        `Connected to ${match.name || match.slug}.${awareness ? `\n\n${awareness}` : ""}`,
      );
      return 0;
    }

    // Full OAuth login
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

    const client = createClient({ apiKey: token, apiUrl });
    const { repoId, repos } = await autoSelectRepo(client);

    if (repoId) {
      saveCredentials({ api_url: apiUrl, api_key: token, repo_id: repoId });
      const session = createSession(client);
      let awareness = "";
      try { awareness = await session.getAwarenessBlock(); } catch { /* best effort */ }
      output.result(
        { space: repos[0]?.slug, repo_id: repoId },
        `Logged in and connected.${awareness ? `\n\n${awareness}` : ""}`,
      );
      return 0;
    }

    if (repos.length > 1) {
      saveCredentials({ api_url: apiUrl, api_key: token });
      output.result(
        { spaces: repos.map((r) => ({ slug: r.slug, name: r.name, repo_id: r.repo_id })) },
        `Logged in. Select a space:\n${formatRepoList(repos)}\n\nRun: ideaspaces login <slug>`,
      );
      return 0;
    }

    output.error("No spaces found for this account.");
    return 1;
  },
};
