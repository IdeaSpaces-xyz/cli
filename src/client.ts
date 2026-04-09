/**
 * Client initialization — load credentials, resolve repo, return connected IsClient.
 */

import { createClient, autoSelectRepo, type IsClient, type RepoInfo } from "@ideaspaces/sdk";
import { loadConfig } from "./auth/credentials.js";
import type { GlobalFlags } from "./types.js";

export function formatRepoList(repos: RepoInfo[]): string {
  return repos
    .map((r) => {
      const name = r.name || r.slug;
      const parts: string[] = [name];
      if (r.hostname) parts.push(r.hostname);
      if (r.file_count != null) parts.push(`${r.file_count} files`);
      if (r.last_activity) parts.push(`active ${r.last_activity}`);
      return `  ${r.slug} — ${parts.join(", ")}`;
    })
    .join("\n");
}

export function resolveRepo(repos: RepoInfo[], ref: string): RepoInfo | undefined {
  return repos.find((r) => r.slug === ref || r.repo_id === ref);
}

export async function initClient(flags: GlobalFlags): Promise<IsClient> {
  const config = loadConfig();
  if (!config) {
    throw new Error("Not logged in. Run: ideaspaces login");
  }

  const repo = flags.repo || config.repo;
  const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl, repo: repo || undefined });

  if (!repo) {
    const { repoId, repos } = await autoSelectRepo(client);
    if (repoId) {
      return client;
    }
    if (repos.length > 1) {
      throw new Error(
        `Multiple spaces available. Use --repo or run: ideaspaces login <slug>\n${formatRepoList(repos)}`,
      );
    }
    throw new Error("No spaces found for this account.");
  }

  return client;
}
