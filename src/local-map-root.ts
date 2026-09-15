import type { MapRoot } from "@ideaspaces/protocol";
import { getDefaultApiUrl, loadConfig } from "./auth/credentials.js";
import { ignoredPaths, statusEntries } from "./git.js";
import { canonicalRepoUrl } from "./repo-locator.js";
import { inspectLocalRootIdentity } from "./root-identity.js";

export interface LocalProjectionRoot {
  local_path: string;
  sha: string | null;
  /** Canonical absolute repository URL, present only for a hosted origin. */
  repo?: string;
  /** Stable root identity, present as soon as the checkout can resolve one safely. */
  root_node_id?: string;
}

export interface PortableLocalRoot {
  root: LocalProjectionRoot;
  portableRoot: MapRoot | null;
  dirty: boolean;
  localOnlyPaths: string[];
}

/**
 * Apply the CLI's one portability gate to an already-read local projection.
 *
 * The helper discovers no identity and mutates nothing. A root must already be
 * identified, pinned, clean, and free of ignored observed paths before it can
 * enter a portable Map. Callers retain their local projection on refusal.
 */
export function inspectPortableLocalRoot(
  repoRoot: string,
  headSha: string | null,
  observedPaths: string[],
): PortableLocalRoot {
  const apiUrl = loadConfig()?.apiUrl ?? getDefaultApiUrl();
  const identity = inspectLocalRootIdentity(repoRoot, apiUrl);
  const root: LocalProjectionRoot = {
    local_path: repoRoot,
    sha: headSha,
    ...(identity.root_node_id ? { root_node_id: identity.root_node_id } : {}),
    ...(identity.canonical_origin
      ? { repo: canonicalRepoUrl(apiUrl, identity.canonical_origin) }
      : {}),
  };
  const localOnlyPaths = ignoredInChunks(observedPaths, repoRoot);
  const dirty = statusEntries(repoRoot).length > 0 || localOnlyPaths.length > 0;
  const portableRoot: MapRoot | null = root.root_node_id && root.sha && !dirty
    ? {
        sha: root.sha,
        root_node_id: root.root_node_id,
        ...(root.repo ? { repo: root.repo } : {}),
      }
    : null;
  return { root, portableRoot, dirty, localOnlyPaths };
}

function ignoredInChunks(paths: string[], repoRoot: string): string[] {
  const found: string[] = [];
  for (let offset = 0; offset < paths.length; offset += 200) {
    found.push(...ignoredPaths(paths.slice(offset, offset + 200), repoRoot));
  }
  return found;
}
