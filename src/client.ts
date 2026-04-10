/**
 * Client initialization — load credentials, resolve repo, return connected IsClient.
 */

import { createClient, autoSelectRepo, type IsClient, type RepoInfo } from "@ideaspaces/sdk";
import { loadConfig } from "./auth/credentials.js";
import type { GlobalFlags } from "./types.js";

export function formatRepoList(repos: RepoInfo[]): string {
  return repos
    .map((r) => {
      const key = r.hostname ? `${r.hostname}/${r.slug}` : r.slug;
      const name = r.name || r.slug;
      const parts: string[] = [name];
      if (r.file_count != null) parts.push(`${r.file_count} files`);
      if (r.last_activity) parts.push(`active ${r.last_activity}`);
      return `  ${key} — ${parts.join(", ")}`;
    })
    .join("\n");
}

export function resolveRepo(repos: RepoInfo[], ref: string): RepoInfo | undefined {
  // Match by repo_id first (exact)
  const byId = repos.find((r) => r.repo_id === ref);
  if (byId) return byId;

  // Match by hostname (org repos: "ideaspaces.xyz" → the org's "notes")
  const byHost = repos.find((r) => r.hostname === ref);
  if (byHost) return byHost;

  // Match by "hostname/slug" (fully qualified: "ideaspaces.xyz/notes")
  if (ref.includes("/")) {
    const [host, slug] = ref.split("/", 2);
    return repos.find((r) => r.hostname === host && r.slug === slug);
  }

  // Match by slug — prefer personal (no hostname) over org
  const bySlug = repos.filter((r) => r.slug === ref);
  if (bySlug.length === 1) return bySlug[0];
  return bySlug.find((r) => !r.hostname) || bySlug[0];
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
