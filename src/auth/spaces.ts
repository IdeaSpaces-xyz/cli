/**
 * Folder-keyed map of published ideaspaces.
 *
 * Stored at ~/.ideaspaces/spaces.json. Keyed by absolute folder path so
 * a single user can publish multiple spaces from different directories
 * without collision. Replaces the single `repo_id` slot in
 * `credentials.ts` (deleted) which silently overwrote on each publish.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configDir } from "./config-dir.js";

function spacesFile(): string {
  return join(configDir(), "spaces.json");
}

export interface SpaceRecord {
  repo_id: string;
  slug: string;
  /** Deprecated display fallback for records written before canonical root locators. */
  namespace: string;
  /** Stable Space identity. Optional only for reading legacy spaces.json records. */
  root_node_id?: string;
  route_status?: "resolved" | "unresolved" | "conflict" | "unavailable";
  route_namespace?: string | null;
  route_slug?: string | null;
  canonical_path?: string | null;
  /**
   * Lineage — written by `fork` only, and only when the server reported it.
   *
   * A fork's git remote points at the copy, not at the source, so without
   * these the clone has no way back to where it came from. A clone or a
   * publish has no source and must leave both unset: absent means "not a
   * fork", not "a fork we forgot to record".
   */
  source_root_node_id?: string;
  /** Source commit the copy was pinned at — the base any later update reads from. */
  source_head?: string;
  /** True once a durable post-fork source baseline has been written locally. */
  source_baseline_initialized?: boolean;
}

/** Map of absolute folder path → space record. */
export type SpacesMap = Record<string, SpaceRecord>;

export function loadSpaces(): SpacesMap {
  const file = spacesFile();
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return {};
    return data as SpacesMap;
  } catch {
    return {};
  }
}

export function saveSpace(absolutePath: string, record: SpaceRecord): void {
  const key = resolve(absolutePath);
  const map = loadSpaces();
  map[key] = record;
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(spacesFile(), JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
}

export function findSpaceFor(absolutePath: string): SpaceRecord | null {
  return loadSpaces()[resolve(absolutePath)] ?? null;
}

/** The clone registry as a list of `{ path, record }` — the shape consumers join on. */
export function listClones(): Array<{ path: string; record: SpaceRecord }> {
  return Object.entries(loadSpaces()).map(([path, record]) => ({ path, record }));
}

/** Remove a clone's registry binding. Returns false if it wasn't tracked. */
export function removeSpace(absolutePath: string): boolean {
  const key = resolve(absolutePath);
  const map = loadSpaces();
  if (!(key in map)) return false;
  delete map[key];
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(spacesFile(), JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  return true;
}

/**
 * The server's view of a Space, plus the two fields only `fork` can supply.
 *
 * `bound` is authoritative: spreading a whole previous record underneath it
 * would preserve fields the server has since dropped — `route_status`,
 * `root_node_id` on a repo that no longer reports one — leaving stale routing
 * or, worse, another Space's identity in a record that names this one.
 *
 * Source lineage fields are the exception because nothing can reconstruct
 * them: `fork` writes the source coordinate and `update` marks baseline
 * initialization. They travel only when the record still names the same Space
 * — a folder repointed elsewhere is not a clone of its old source.
 */
export function withForkLineage(bound: SpaceRecord, previous: SpaceRecord | null): SpaceRecord {
  if (!previous || previous.repo_id !== bound.repo_id) return bound;
  return {
    ...bound,
    ...(previous.source_root_node_id
      ? { source_root_node_id: previous.source_root_node_id }
      : {}),
    ...(previous.source_head ? { source_head: previous.source_head } : {}),
    ...(previous.source_baseline_initialized
      ? { source_baseline_initialized: true }
      : {}),
  };
}
