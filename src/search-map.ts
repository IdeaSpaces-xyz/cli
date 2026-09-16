/**
 * Seal a ranked local search result as a portable Map — the same gate `look`
 * landed, applied to many positions instead of one.
 *
 * The Map is available only when the repository is identified, pinned, and
 * clean, every hit is tracked at that HEAD, and HEAD is the same after the
 * hits' disclosure is read as before the search ran. Otherwise the search
 * result stands on its own with `map_status: "projection_pending"` and
 * `map: null` — never a partial Map, never a machine path. Rank stays in the
 * operation result; member order carries it.
 */

import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  buildMap,
  parseFrontmatter,
  summarizeMarkdown,
  type MapBlock,
  type MapParseIssue,
  type MapPositionMember,
} from "@ideaspaces/protocol";
import { headSha as readHeadSha, trackedAt } from "./git.js";
import { inspectPortableLocalRoot, type LocalProjectionRoot } from "./local-map-root.js";

export type SearchMapStatus = "available" | "projection_pending";

export interface SearchMapProjection {
  map_status: SearchMapStatus;
  map: MapBlock | null;
  root: LocalProjectionRoot;
  dirty: boolean | null;
  local_only_paths: string[];
  map_issues?: MapParseIssue[];
  /** Why the Map is pending, when the reason is not plain dirtiness. */
  portability_issue?: string;
}

export interface SearchMapDependencies {
  headSha?: (repoRoot: string) => string | null;
  trackedAt?: (repoRoot: string) => Set<string>;
  readSource?: (repoRoot: string, path: string) => string;
}

function safeHead(repoRoot: string): string | null {
  try {
    return readHeadSha(repoRoot);
  } catch {
    return null;
  }
}

/** A hit in Map member vocabulary, at the summary rung, as `look` names a Note. */
function member(path: string, source: string): MapPositionMember {
  const frontmatter = parseFrontmatter(source);
  const rawName = frontmatter?.name;
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : basename(path, extname(path));
  const summary = summarizeMarkdown(source);
  return {
    root: 0,
    position: path,
    depth: "summary",
    disclosure: { name, ...(summary !== null ? { summary } : {}) },
  };
}

/**
 * `headBefore` is HEAD as observed before the search read any file. The hits
 * are read again here for disclosure, then HEAD is observed once more; the
 * Map is sealed only when both observations agree and the tree was clean.
 */
export function projectSearchMap(
  repoRoot: string,
  headBefore: string | null,
  hitPaths: readonly string[],
  dependencies: SearchMapDependencies = {},
): SearchMapProjection {
  const headSha = dependencies.headSha ?? safeHead;
  const tracked = dependencies.trackedAt ?? ((root: string) => trackedAt("HEAD", root));
  const readSource = dependencies.readSource ?? ((root: string, path: string) => readFileSync(join(root, path), "utf-8"));

  // Disclosure is read first, so the clean-tree and HEAD checks that follow
  // cover the bytes that entered the Map, not an earlier moment.
  let members: MapPositionMember[] | null = null;
  let readIssue: string | undefined;
  try {
    members = hitPaths.map((path) => member(path, readSource(repoRoot, path)));
  } catch (error) {
    readIssue = `Could not read a hit for disclosure: ${error instanceof Error ? error.message : String(error)}`;
  }

  const inspected = inspectPortableLocalRoot(repoRoot, headBefore, [...hitPaths]);
  const pending = (extra: Partial<SearchMapProjection> = {}): SearchMapProjection => ({
    map_status: "projection_pending",
    map: null,
    root: inspected.root,
    dirty: inspected.dirty,
    local_only_paths: inspected.localOnlyPaths,
    ...extra,
  });
  if (!inspected.portableRoot) return pending();
  if (!members) return pending({ portability_issue: readIssue });

  const atHead = tracked(repoRoot);
  const untracked = hitPaths.filter((path) => !atHead.has(path));
  if (untracked.length) {
    return pending({ portability_issue: `Not tracked at HEAD: ${untracked.join(", ")}` });
  }
  if (headSha(repoRoot) !== headBefore) {
    return pending({ portability_issue: "Git HEAD changed while verifying the portable Map" });
  }

  const built = buildMap({ roots: [inspected.portableRoot], members });
  if (built.status === "invalid") return pending({ map_issues: built.issues });
  return {
    map_status: "available",
    map: built.map,
    root: inspected.root,
    dirty: inspected.dirty,
    local_only_paths: inspected.localOnlyPaths,
  };
}
