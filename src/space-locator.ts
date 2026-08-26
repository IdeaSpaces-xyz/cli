import { deriveGitBase, deriveWebBase, type AuthMeRepo, type AuthMeResponse } from "./auth/api.js";
import { normalizeRepoUrl } from "./git.js";
import type { HostedSpaceRecord } from "./auth/spaces.js";

/** The node-id shape itself, shared so a matcher and a validator cannot drift. */
const NODE_ID_PATTERN = "n_(?:[0-9a-f]{12}|[0-9a-f]{24})";
const NODE_ID_RE = new RegExp(`^${NODE_ID_PATTERN}$`);

export interface SpaceLocator {
  rootNodeId: string;
  canonicalUrl: string;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** User-facing stable Space identity. */
export function canonicalSpaceUrl(apiUrl: string, rootNodeId: string): string {
  return `${withoutTrailingSlash(deriveWebBase(apiUrl))}/spaces/${encodeURIComponent(rootNodeId)}`;
}

/** Internal smart-HTTP transport endpoint for one stable Space identity. */
export function canonicalGitUrl(apiUrl: string, rootNodeId: string): string {
  return `${withoutTrailingSlash(deriveGitBase(apiUrl))}/spaces/${encodeURIComponent(rootNodeId)}.git`;
}

/**
 * Parse only an exact Space locator on this CLI's configured web origin.
 *
 * This is deliberately not a general URL resolver: clone/fork must never turn
 * caller-supplied URLs into arbitrary network fetches.
 */
export function parseSpaceLocator(value: string, apiUrl: string): SpaceLocator {
  let supplied: URL;
  let configured: URL;
  try {
    supplied = new URL(value);
    configured = new URL(deriveWebBase(apiUrl));
  } catch {
    throw new Error("Expected a canonical Space URL: /spaces/{root_node_id}");
  }

  if (
    supplied.origin !== configured.origin ||
    supplied.username ||
    supplied.password ||
    supplied.search ||
    supplied.hash
  ) {
    throw new Error(`Space URL must use the configured host ${configured.origin}`);
  }

  const basePath = configured.pathname.replace(/\/+$/, "");
  const prefix = `${basePath}/spaces/`;
  if (!supplied.pathname.startsWith(prefix)) {
    throw new Error("Expected a canonical Space URL: /spaces/{root_node_id}");
  }
  const rootNodeId = supplied.pathname.slice(prefix.length);
  if (!NODE_ID_RE.test(rootNodeId)) {
    throw new Error("Space URL must contain one valid root_node_id and no trailing path");
  }

  return {
    rootNodeId,
    canonicalUrl: canonicalSpaceUrl(apiUrl, rootNodeId),
  };
}

/** Route display from the canonical projection, with old-server compatibility. */
export function repoRouteNamespace(repo: AuthMeRepo, username: string | null): string | null {
  if (repo.route_status !== undefined) {
    return repo.route_status === "resolved" ? (repo.route_namespace ?? null) : null;
  }
  return repo.hostname ?? username;
}

/** Build an additive registry record while preserving old-reader compatibility. */
export function spaceRecordForRepo(repo: AuthMeRepo, username: string | null): HostedSpaceRecord {
  const routeNamespace = repoRouteNamespace(repo, username);
  return {
    repo_id: repo.repo_id,
    slug: repo.route_slug ?? repo.slug,
    namespace: routeNamespace ?? repo.hostname ?? username ?? "",
    ...(repo.root_node_id ? { root_node_id: repo.root_node_id } : {}),
    ...(repo.route_status ? { route_status: repo.route_status } : {}),
    ...(repo.route_namespace !== undefined ? { route_namespace: repo.route_namespace } : {}),
    ...(repo.route_slug !== undefined ? { route_slug: repo.route_slug } : {}),
    ...(repo.canonical_path !== undefined ? { canonical_path: repo.canonical_path } : {}),
  };
}

/**
 * Every git URL that would be a clone of this Space — canonical and legacy.
 *
 * A Space is reachable at `/spaces/{root_node_id}.git` and, for repos that
 * predate that form, at `/{namespace}/{slug}.git`. Matching an origin means
 * comparing against both: which one a clone holds says when it was made, not
 * which Space it is.
 */
export function repoKeys(
  repo: AuthMeRepo,
  me: AuthMeResponse,
  gitBase: string,
  apiUrl: string,
): string[] {
  const keys: string[] = [];
  if (repo.root_node_id) {
    const canonical = normalizeRepoUrl(canonicalGitUrl(apiUrl, repo.root_node_id));
    if (canonical) keys.push(canonical);
  }
  const namespace = repoRouteNamespace(repo, me.username);
  if (namespace) {
    const legacy = normalizeRepoUrl(`${gitBase}/${namespace}/${repo.route_slug ?? repo.slug}.git`);
    if (legacy) keys.push(legacy);
  }
  return keys;
}

/**
 * The root node id carried by a canonical clone URL, or null.
 *
 * `/spaces/{root_node_id}.git` puts the Space's stable identity in the remote
 * itself, so a clone made since that form landed needs no registry entry and no
 * network call to say which Space it is.
 *
 * `apiUrl` is required rather than optional: the host must match, because a
 * node id addressed at the wrong deployment is not this Space, and an optional
 * argument is a check a future caller can skip by forgetting it. Callers
 * without a session pass the environment's default.
 */
export function rootNodeIdFromGitUrl(url: string, apiUrl: string): string | null {
  let parsed: URL;
  try {
    // scp-style (`git@host:spaces/n_….git`) is not a URL. The CLI only ever
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
  const match = new RegExp(`^/spaces/(${NODE_ID_PATTERN})\\.git$`).exec(parsed.pathname);
  return match ? match[1] : null;
}
