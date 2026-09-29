import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter, type MapMember, type MapRoot } from "@ideaspaces/protocol";
import { isHostedSpaceRecord, loadSpaces, type SpacesMap } from "../auth/spaces.js";
import { getDefaultApiUrl, loadConfig } from "../auth/credentials.js";
import { headSha } from "../git.js";
import { canonicalRepoUrl, parseRepoLocator } from "../repo-locator.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { loadMapNote, type LoadedMapNote } from "./map-note.js";

export type SpaceMapRootStatus = "pinned" | "moved" | "unresolved";

export interface SpaceMapRootDrift {
  root: MapRoot;
  rootIndex: number;
  rootNodeId: string | null;
  repo: string | null;
  pinnedSha: string;
  status: SpaceMapRootStatus;
  drift: boolean;
  headSha: string | null;
  checkoutPath: string | null;
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

function getRepoRootNodeId(dir: string): string | null {
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    const report = inspectLocalRootIdentity(dir);
    return report.root_node_id;
  } catch {
    return null;
  }
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
      const fm = parseFrontmatter(readFileSync(readme, "utf8"));
      if (fm && Object.hasOwn(fm, "map")) mapFiles.push("README.md");
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
export function inspectSpaceMapRoots(roots: MapRoot[], contextDir: string): SpaceMapRootDrift[] {
  let knownSpaces: SpacesMap | null = null;
  let selfId: string | null | undefined;
  let childPaths: Map<string, string> | null = null;
  const apiUrl = loadConfig()?.apiUrl ?? getDefaultApiUrl();

  const findChild = (rootNodeId: string): string | null => {
    if (!childPaths) {
      childPaths = new Map();
      try {
        for (const dirent of readdirSync(contextDir, { withFileTypes: true })) {
          if (!dirent.isDirectory() || dirent.name.startsWith(".") || dirent.name.startsWith("_")) continue;
          const candidate = join(contextDir, dirent.name);
          const id = getRepoRootNodeId(candidate);
          if (id && !childPaths.has(id)) childPaths.set(id, candidate);
        }
      } catch {
        // Unreadable folders do not resolve any root; registry matching still works.
      }
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
      if (selfId === undefined) selfId = getRepoRootNodeId(contextDir);
      if (selfId === rootNodeId) checkoutPath = contextDir;
    }

    // 2. Check immediate subdirectories once, however many roots the Map pins.
    if (!checkoutPath && rootNodeId) checkoutPath = findChild(rootNodeId);

    // 3. Check registered spaces
    if (!checkoutPath) {
      if (!knownSpaces) {
        try {
          knownSpaces = loadSpaces();
        } catch {
          knownSpaces = {};
        }
      }
      for (const [registeredPath, record] of Object.entries(knownSpaces)) {
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
      if (head === pinnedSha) {
        status = "pinned";
        drift = false;
      } else {
        status = "moved";
        drift = true;
      }
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
    };
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
