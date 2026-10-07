import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter, type MapMember, type MapRoot } from "@ideaspaces/protocol";
import { isHostedSpaceRecord, loadSpaces, type SpacesMap } from "../auth/spaces.js";
import { getDefaultApiUrl, loadConfig } from "../auth/credentials.js";
import { deriveGitBase } from "../auth/api.js";
import { headSha, normalizeRepoUrl, originUrl } from "../git.js";
import { canonicalRepoUrl, parseRepoLocator } from "../repo-locator.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { loadMapNote, type LoadedMapNote } from "./map-note.js";

export type SpaceMapRootStatus = "pinned" | "moved" | "found" | "unresolved";

export interface SpaceMapRootDrift {
  root: MapRoot;
  rootIndex: number;
  rootNodeId: string | null;
  repo: string | null;
  pinnedSha?: string;
  status: SpaceMapRootStatus;
  drift: boolean;
  headSha: string | null;
  checkoutPath: string | null;
  /** The folder walk below the context hit its cap before this unresolved root was found. */
  searchCapped?: boolean;
}

export interface SpaceMapDiscovery {
  file: string;
  otherFiles: string[];
}

export interface SpaceMapInspection {
  file: string;
  otherFiles: string[];
  absolutePath: string;
  note: LoadedMapNote;
  roots: SpaceMapRootDrift[];
  members: MapMember[];
}

function rootNodeIdFromRepoUrl(url: string | undefined, apiUrl: string): string | null {
  if (!url) return null;
  try {
    return parseRepoLocator(url, apiUrl).rootNodeId;
  } catch {
    return null;
  }
}

function parseNamespaceAndSlugFromRepoUrl(url: string | undefined, apiUrl: string): { namespace: string; slug: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const configured = new URL(canonicalRepoUrl(apiUrl, "n_000000000000"));
    if (parsed.origin !== configured.origin || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] !== "repos" && parts[0] !== "spaces") {
      return { namespace: parts[0], slug: parts[1].replace(/\.git$/, "") };
    }
  } catch {
    // ignore invalid URL
  }
  return null;
}

/** Folder levels below the context searched for checkouts; a grouped `<group>/<name>` is two. */
export const CHECKOUT_SEARCH_DEPTH = 3;
/** Bound on folders visited, so a Map read from inside a large tree stays cheap. */
export const CHECKOUT_SEARCH_LIMIT = 2_000;
const SKIPPED_FOLDERS = new Set(["node_modules"]);

function getRepoRootNodeId(dir: string, apiUrl: string, spaces: () => SpacesMap): string | null {
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    const report = inspectLocalRootIdentity(dir, apiUrl);
    return report.root_node_id ?? rootNodeIdFromRouteOrigin(dir, apiUrl, spaces());
  } catch {
    return null;
  }
}

/**
 * A checkout cloned by route (`<git-host>/<namespace>/<slug>.git`) declares no identity of its
 * own. Its registry record does, wherever that record says the folder was: checkouts move, and
 * the route on the configured host still names the same repository.
 */
function rootNodeIdFromRouteOrigin(dir: string, apiUrl: string, spaces: SpacesMap): string | null {
  const origin = originUrl(dir);
  const key = origin ? normalizeRepoUrl(origin) : null;
  if (!key) return null;
  let gitHost: string;
  try {
    gitHost = new URL(deriveGitBase(apiUrl)).hostname.toLowerCase();
  } catch {
    return null;
  }
  const [host, namespace, slug, ...rest] = key.split("/");
  if (host !== gitHost || !namespace || !slug || rest.length) return null;
  for (const record of Object.values(spaces)) {
    if (!record || typeof record !== "object" || !isHostedSpaceRecord(record) || !record.root_node_id) continue;
    const routed = record.route_namespace === namespace && record.route_slug === slug;
    const legacy = !record.route_slug && record.namespace === namespace && record.slug === slug;
    if (routed || legacy) return record.root_node_id;
  }
  return null;
}

/** Discover all `*.map.md` files in the directory and pick the curated primary. */
export function discoverSpaceMapFiles(dir: string): SpaceMapDiscovery | null {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    const entries = readdirSync(dir, { withFileTypes: true });
    const mapFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".map.md") && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    // README is a Space only when its frontmatter declares a Map. An invalid
    // declared Map remains visible to the reader as an error, not a fallback.
    const readme = join(dir, "README.md");
    if (existsSync(readme) && statSync(readme).isFile()) {
      const content = readFileSync(readme, "utf8");
      const fm = parseFrontmatter(content);
      // Even when YAML is malformed, a declared map must fail visibly rather
      // than silently falling back to the derived tree.
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(content);
      if ((fm && Object.hasOwn(fm, "map")) || (front && /^map\s*:/m.test(front[1]))) mapFiles.push("README.md");
    }
    if (!mapFiles.length) return null;
    const chosen = mapFiles.includes("home.map.md") ? "home.map.md" : mapFiles.includes("README.md") ? "README.md" : mapFiles[0];
    const otherFiles = mapFiles.filter((f) => f !== chosen);
    return { file: chosen, otherFiles };
  } catch {
    return null;
  }
}

/** Find a curated Map note, including a README that declares a Map. */
export function findSpaceMapFile(dir: string): string | null {
  return discoverSpaceMapFiles(dir)?.file ?? null;
}

/** Inspect all roots in a Map against local checkouts to determine drift. */
export function inspectSpaceMapRoots(roots: MapRoot[], context: string): SpaceMapRootDrift[] {
  // Report checkouts by their real path, as the registry records them.
  let contextDir = context;
  try {
    contextDir = realpathSync.native(context);
  } catch {
    // A missing context resolves nothing below it; the registry still answers.
  }
  let knownSpaces: SpacesMap | null = null;
  let selfId: string | null | undefined;
  let childPaths: Map<string, string> | null = null;
  let capped = false;
  const apiUrl = loadConfig()?.apiUrl ?? getDefaultApiUrl();
  const spaces = (): SpacesMap => {
    if (!knownSpaces) {
      try {
        knownSpaces = loadSpaces();
      } catch {
        knownSpaces = {};
      }
    }
    return knownSpaces;
  };

  // Checkouts below the context, once however many roots the Map pins. A folder that is a
  // checkout is a boundary: its own subfolders belong to it. Plain grouping folders are
  // walked through, down to CHECKOUT_SEARCH_DEPTH levels.
  const findChild = (rootNodeId: string): string | null => {
    if (!childPaths) {
      const found = new Map<string, string>();
      let visited = 0;
      let level = [contextDir];
      for (let depth = 1; depth <= CHECKOUT_SEARCH_DEPTH && level.length; depth++) {
        const next: string[] = [];
        for (const parent of level) {
          let entries;
          try {
            entries = readdirSync(parent, { withFileTypes: true });
          } catch {
            // Unreadable folders do not resolve any root; registry matching still works.
            continue;
          }
          for (const dirent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!dirent.isDirectory() || dirent.name.startsWith(".") || dirent.name.startsWith("_")) continue;
            if (SKIPPED_FOLDERS.has(dirent.name)) continue;
            if (++visited > CHECKOUT_SEARCH_LIMIT) {
              capped = true;
              continue;
            }
            const candidate = join(parent, dirent.name);
            if (existsSync(join(candidate, ".git"))) {
              const id = getRepoRootNodeId(candidate, apiUrl, spaces);
              if (id && !found.has(id)) found.set(id, candidate);
            } else {
              next.push(candidate);
            }
          }
        }
        level = next;
      }
      childPaths = found;
    }
    return childPaths.get(rootNodeId) ?? null;
  };

  return roots.map((root, rootIndex) => {
    const repo = root.repo ?? null;
    const repoId = rootNodeIdFromRepoUrl(root.repo, apiUrl);
    const routeInfo = parseNamespaceAndSlugFromRepoUrl(root.repo, apiUrl);
    // The protocol can infer root_node_id from any syntactically valid repo URL.
    // A foreign host is still untrusted local navigation data, not a checkout binding.
    const rootNodeId = repo && !repoId && !routeInfo ? null : root.root_node_id ?? repoId;
    const pinnedSha = root.sha;

    let checkoutPath: string | null = null;

    // 1. Check context directory itself
    if (rootNodeId) {
      if (selfId === undefined) selfId = getRepoRootNodeId(contextDir, apiUrl, spaces);
      if (selfId === rootNodeId) checkoutPath = contextDir;
    }

    // 2. Check checkouts below the context.
    if (!checkoutPath && rootNodeId) checkoutPath = findChild(rootNodeId);

    // 3. Check registered spaces
    if (!checkoutPath) {
      for (const [registeredPath, record] of Object.entries(spaces())) {
        if (!record || typeof record !== "object") continue;

        const matchesId =
          rootNodeId &&
          (record.root_node_id === rootNodeId ||
            record.canonical_path === `/repos/${rootNodeId}` ||
            record.canonical_path === `/spaces/${rootNodeId}`);

        const matchesRoute =
          routeInfo &&
          isHostedSpaceRecord(record) &&
          ((record.route_namespace === routeInfo.namespace && record.route_slug === routeInfo.slug) ||
            (record.namespace === routeInfo.namespace && record.slug === routeInfo.slug));

        if (matchesId || matchesRoute) {
          if (existsSync(registeredPath)) {
            checkoutPath = registeredPath;
            break;
          }
        }
      }
    }

    // 4. Determine status and drift
    let head: string | null = null;
    if (checkoutPath) {
      try {
        head = headSha(checkoutPath);
      } catch {
        // An unborn or unreadable checkout cannot be compared to a pin.
        // Keep every other root visible in the curated Map.
      }
    }

    let status: SpaceMapRootStatus = "unresolved";
    let drift = false;

    if (head) {
      if (!pinnedSha) status = "found";
      else if (head === pinnedSha) status = "pinned";
      else { status = "moved"; drift = true; }
    }

    return {
      root,
      rootIndex,
      rootNodeId,
      repo,
      pinnedSha,
      status,
      drift,
      headSha: head,
      checkoutPath,
      ...(!checkoutPath && capped ? { searchCapped: true } : {}),
    };
  });
}

/** The root identity of one checkout, by declaration, canonical origin, or registry route. */
export function checkoutRootNodeId(dir: string): string | null {
  const apiUrl = loadConfig()?.apiUrl ?? getDefaultApiUrl();
  let spaces: SpacesMap | null = null;
  return getRepoRootNodeId(dir, apiUrl, () => {
    if (!spaces) {
      try {
        spaces = loadSpaces();
      } catch {
        spaces = {};
      }
    }
    return spaces;
  });
}

/** Load and inspect a curated `*.map.md` in the target directory if one exists. */
export function inspectSpaceMap(dir: string, mapFileName?: string): SpaceMapInspection | null {
  const discovery = discoverSpaceMapFiles(dir);
  const fileName = mapFileName ?? discovery?.file;
  if (!fileName) return null;

  const note = loadMapNote(fileName, dir);
  const roots = inspectSpaceMapRoots(note.map.roots, dir);
  return {
    file: fileName,
    otherFiles: discovery?.otherFiles ?? [],
    absolutePath: resolve(dir, fileName),
    note,
    roots,
    members: note.map.members,
  };
}
