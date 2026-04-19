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

// repo_id format mirrors the server's _REPO_ID_RE: "repo_" + 12 hex chars.
// Used to decide whether flags.repo needs slug/hostname resolution.
const REPO_ID_RE = /^repo_[a-f0-9]{12}$/;

export async function initClient(flags: GlobalFlags): Promise<IsClient> {
  const config = loadConfig();
  if (!config) {
    throw new Error("Not logged in. Run: ideaspaces login");
  }

  const client = createClient({ apiKey: config.apiKey, apiUrl: config.apiUrl });

  // Resolve --repo: accepts slug, hostname, hostname/slug, or repo_id.
  // config.repo is always a repo_id (login stores the resolved form).
  let repoId: string | undefined;
  if (flags.repo) {
    if (REPO_ID_RE.test(flags.repo)) {
      repoId = flags.repo;
    } else {
      const { data } = await client.listRepos();
      const match = resolveRepo(data.repos, flags.repo);
      if (!match) {
        throw new Error(
          `Space "${flags.repo}" not found. Available:\n${formatRepoList(data.repos)}`,
        );
      }
      repoId = match.repo_id;
    }
  } else if (config.repo) {
    repoId = config.repo;
  }

  if (repoId) {
    client.setRepo(repoId);
    return client;
  }

  // No --repo, no stored default → try to auto-select.
  const { repoId: autoId, repos } = await autoSelectRepo(client);
  if (autoId) {
    return client;
  }
  if (repos.length > 1) {
    throw new Error(
      `Multiple spaces available. Use --repo or run: ideaspaces login <slug>\n${formatRepoList(repos)}`,
    );
  }
  throw new Error("No spaces found for this account.");
}
