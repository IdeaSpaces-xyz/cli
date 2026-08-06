import { deriveGitBase, deriveWebBase, type AuthMeRepo } from "./auth/api.js";
import type { SpaceRecord } from "./auth/spaces.js";

const NODE_ID_RE = /^n_(?:[0-9a-f]{12}|[0-9a-f]{24})$/;

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
export function spaceRecordForRepo(repo: AuthMeRepo, username: string | null): SpaceRecord {
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
