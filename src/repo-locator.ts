import { deriveGitBase, deriveWebBase, type AuthMeRepo, type AuthMeResponse } from "./auth/api.js";
import { normalizeRepoUrl } from "./git.js";
import type { HostedSpaceRecord } from "./auth/spaces.js";

/** The node-id shape itself, shared so a matcher and a validator cannot drift. */
const NODE_ID_PATTERN = "n_(?:[0-9a-f]{12}|[0-9a-f]{24})";
const NODE_ID_RE = new RegExp(`^${NODE_ID_PATTERN}$`);

/**
 * The canonical path segment, and the one it replaced.
 *
 * `/spaces` addressed repo roots before Space became the larger
 * agreement-bearing primitive. Readers accept both, because links, clones, and
 * registry entries made under the old form stay valid indefinitely; every
 * emitter writes only `/repos`.
 */
const CANONICAL_SEGMENT = "repos";
const LEGACY_SEGMENT = "spaces";

export interface RepoLocator {
  rootNodeId: string;
  canonicalUrl: string;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** User-facing stable repository identity — the one URL a person exchanges. */
export function canonicalRepoUrl(apiUrl: string, rootNodeId: string): string {
  return `${withoutTrailingSlash(deriveWebBase(apiUrl))}/${CANONICAL_SEGMENT}/${encodeURIComponent(rootNodeId)}`;
}

/** Internal smart-HTTP transport endpoint for one stable repository identity. */
export function canonicalGitUrl(apiUrl: string, rootNodeId: string): string {
  return `${withoutTrailingSlash(deriveGitBase(apiUrl))}/${CANONICAL_SEGMENT}/${encodeURIComponent(rootNodeId)}.git`;
}

/** The transport endpoint this CLI emitted before `/repos`. Still served. */
function legacyGitUrl(apiUrl: string, rootNodeId: string): string {
  return `${withoutTrailingSlash(deriveGitBase(apiUrl))}/${LEGACY_SEGMENT}/${encodeURIComponent(rootNodeId)}.git`;
}

/**
 * Parse only an exact repo locator on this CLI's configured web origin.
 *
 * This is deliberately not a general URL resolver: clone/fork must never turn
 * caller-supplied URLs into arbitrary network fetches. Legacy `/spaces/{id}`
 * addresses resolve to the same root and are answered with the canonical form,
 * so a person holding an old link is corrected rather than refused.
 */
export function parseRepoLocator(value: string, apiUrl: string): RepoLocator {
  let supplied: URL;
  let configured: URL;
  try {
    supplied = new URL(value);
    configured = new URL(deriveWebBase(apiUrl));
  } catch {
    throw new Error("Expected a canonical repository URL: /repos/{root_node_id}");
  }

  if (
    supplied.origin !== configured.origin ||
    supplied.username ||
    supplied.password ||
    supplied.search ||
    supplied.hash
  ) {
    throw new Error(`Repository URL must use the configured host ${configured.origin}`);
  }

  const basePath = configured.pathname.replace(/\/+$/, "");
  const segment = [CANONICAL_SEGMENT, LEGACY_SEGMENT].find((candidate) =>
    supplied.pathname.startsWith(`${basePath}/${candidate}/`),
  );
  if (!segment) {
    throw new Error("Expected a canonical repository URL: /repos/{root_node_id}");
  }
  const rootNodeId = supplied.pathname.slice(`${basePath}/${segment}/`.length);
  if (!NODE_ID_RE.test(rootNodeId)) {
    throw new Error("Repository URL must contain one valid root_node_id and no trailing path");
  }

  return {
    rootNodeId,
    canonicalUrl: canonicalRepoUrl(apiUrl, rootNodeId),
  };
}

/** Route display from the canonical projection, with old-server compatibility. */
export function repoRouteNamespace(repo: AuthMeRepo, username: string | null): string | null {
  if (repo.route_status !== undefined) {
    return repo.route_status === "resolved" ? (repo.route_namespace ?? null) : null;
  }
  return repo.hostname ?? username;
}

export function repoDisplaySlug(repo: AuthMeRepo): string {
  return repo.route_slug ?? repo.slug ?? repo.repo_id;
}

/** Build an additive registry record while preserving old-reader compatibility. */
export function spaceRecordForRepo(repo: AuthMeRepo, username: string | null): HostedSpaceRecord {
  const routeNamespace = repoRouteNamespace(repo, username);
  return {
    repo_id: repo.repo_id,
    slug: repoDisplaySlug(repo),
    namespace: routeNamespace ?? repo.hostname ?? username ?? "",
    ...(repo.root_node_id ? { root_node_id: repo.root_node_id } : {}),
    ...(repo.route_status ? { route_status: repo.route_status } : {}),
    ...(repo.route_namespace !== undefined ? { route_namespace: repo.route_namespace } : {}),
    ...(repo.route_slug !== undefined ? { route_slug: repo.route_slug } : {}),
    ...(repo.canonical_path !== undefined ? { canonical_path: repo.canonical_path } : {}),
  };
}

/**
 * Every git URL that would be a clone of this repo — canonical and legacy.
 *
 * A repo is reachable at `/repos/{root_node_id}.git`, at the `/spaces` form
 * this CLI wrote before the rename, and, for repos that predate root-addressed
 * transport, at `/{namespace}/{slug}.git`. Matching an origin means comparing
 * against all three: which one a clone holds says when it was made, not which
 * repo it is.
 */
export function repoKeys(
  repo: AuthMeRepo,
  me: AuthMeResponse,
  gitBase: string,
  apiUrl: string,
): string[] {
  const keys: string[] = [];
  if (repo.root_node_id) {
    for (const url of [
      canonicalGitUrl(apiUrl, repo.root_node_id),
      legacyGitUrl(apiUrl, repo.root_node_id),
    ]) {
      const normalized = normalizeRepoUrl(url);
      if (normalized) keys.push(normalized);
    }
  }
  const namespace = repoRouteNamespace(repo, me.username);
  const slug = repo.route_slug ?? repo.slug;
  if (namespace && slug) {
    const legacy = normalizeRepoUrl(`${gitBase}/${namespace}/${slug}.git`);
    if (legacy) keys.push(legacy);
  }
  return keys;
}

/**
 * The root node id carried by a canonical clone URL, or null.
 *
 * `/repos/{root_node_id}.git` puts the repo's stable identity in the remote
 * itself, so a clone made since that form landed needs no registry entry and no
 * network call to say which repo it is. The `/spaces` form means the same
 * thing and keeps working: a fork holder is never asked to re-clone because we
 * renamed a path.
 *
 * `apiUrl` is required rather than optional: the host must match, because a
 * node id addressed at the wrong deployment is not this repo, and an optional
 * argument is a check a future caller can skip by forgetting it. Callers
 * without a session pass the environment's default.
 */
export function rootNodeIdFromGitUrl(url: string, apiUrl: string): string | null {
  let parsed: URL;
  try {
    // scp-style (`git@host:repos/n_….git`) is not a URL. The CLI only ever
    // writes https origins, but a reader may rewrite theirs to SSH — and a
    // fork holder rewriting their remote is exactly the caller this rung
    // serves, so falling through to an account lookup they cannot pass would
    // strand them.
    const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(url.trim());
    parsed = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : url);
  } catch {
    return null;
  }
  try {
    if (parsed.host !== new URL(deriveGitBase(apiUrl)).host) return null;
  } catch {
    return null;
  }
  const match = new RegExp(
    `^/(?:${CANONICAL_SEGMENT}|${LEGACY_SEGMENT})/(${NODE_ID_PATTERN})\\.git$`,
  ).exec(parsed.pathname);
  return match ? match[1] : null;
}
