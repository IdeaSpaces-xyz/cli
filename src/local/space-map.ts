import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter, type MapMember, type MapRoot } from "@ideaspaces/protocol";
import { isHostedSpaceRecord, loadSpaces, type SpacesMap } from "../auth/spaces.js";
import { headSha } from "../git.js";
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

const ROOT_NODE_ID_RE = /(?:^|\/|\b)(n_[0-9a-f]{24})(?:\.git|\/|\b|$)/i;

function extractRootNodeIdFromRepoUrl(url?: string): string | null {
  if (!url) return null;
  const match = url.match(ROOT_NODE_ID_RE);
  return match ? match[1] : null;
}

function parseNamespaceAndSlugFromRepoUrl(url?: string): { namespace: string; slug: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] !== "repos" && parts[0] !== "spaces") {
      const slug = parts[1].replace(/\.git$/, "");
      return { namespace: parts[0], slug };
    }
  } catch {
    // ignore invalid URL
  }
  return null;
}

function readContractRootNodeId(dir: string): string | null {
  const agreementPath = join(dir, "_agent", "agreement.md");
  const foundationPath = join(dir, "_agent", "foundation.md");

  for (const candidate of [agreementPath, foundationPath]) {
    if (!existsSync(candidate)) continue;
    try {
      const content = readFileSync(candidate, "utf8");
      const fm = parseFrontmatter(content);
      if (fm) {
        if (typeof fm.root_node_id === "string" && fm.root_node_id.trim()) {
          return fm.root_node_id.trim();
        }
        if (typeof fm.agreement === "string") {
          const match = fm.agreement.match(ROOT_NODE_ID_RE);
          if (match) return match[1];
        }
      }
    } catch {
      // ignore unreadable contract
    }
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
    if (!mapFiles.length) return null;
    const chosen = mapFiles.includes("home.map.md") ? "home.map.md" : mapFiles[0];
    const otherFiles = mapFiles.filter((f) => f !== chosen);
    return { file: chosen, otherFiles };
  } catch {
    return null;
  }
}

/** Find a curated `*.map.md` in the target directory (prefers `home.map.md` if present). */
export function findSpaceMapFile(dir: string): string | null {
  return discoverSpaceMapFiles(dir)?.file ?? null;
}

/** Inspect all roots in a Map against local checkouts to determine drift. */
export function inspectSpaceMapRoots(roots: MapRoot[], contextDir: string): SpaceMapRootDrift[] {
  let knownSpaces: SpacesMap | null = null;

  return roots.map((root, rootIndex) => {
    const rootNodeId = root.root_node_id ?? extractRootNodeIdFromRepoUrl(root.repo);
    const repo = root.repo ?? null;
    const routeInfo = parseNamespaceAndSlugFromRepoUrl(root.repo);
    const pinnedSha = root.sha;

    let checkoutPath: string | null = null;

    // 1. Check context directory itself
    if (rootNodeId && existsSync(join(contextDir, ".git"))) {
      const selfId = readContractRootNodeId(contextDir);
      if (selfId && selfId === rootNodeId) {
        checkoutPath = contextDir;
      }
    }

    // 2. Check immediate subdirectories of contextDir
    if (!checkoutPath && existsSync(contextDir) && statSync(contextDir).isDirectory()) {
      try {
        const subdirs = readdirSync(contextDir, { withFileTypes: true });
        for (const dirent of subdirs) {
          if (!dirent.isDirectory() || dirent.name.startsWith(".") || dirent.name.startsWith("_")) {
            continue;
          }
          const candidate = join(contextDir, dirent.name);
          if (existsSync(join(candidate, ".git"))) {
            const candidateId = readContractRootNodeId(candidate);
            if (candidateId && rootNodeId && candidateId === rootNodeId) {
              checkoutPath = candidate;
              break;
            }
          }
        }
      } catch {
        // ignore readdir error
      }
    }

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
            record.source_root_node_id === rootNodeId ||
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
      head = headSha(checkoutPath);
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

  try {
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
  } catch {
    return null;
  }
}
