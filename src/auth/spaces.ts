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
