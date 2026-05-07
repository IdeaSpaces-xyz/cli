/**
 * Folder-keyed map of published ideaspaces.
 *
 * Stored at ~/.ideaspaces/spaces.json. Keyed by absolute folder path so
 * a single user can publish multiple spaces from different directories
 * without collision. Replaces the single `repo_id` slot in
 * `credentials.ts` (deleted) which silently overwrote on each publish.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Compute lazily so tests can override HOME between vi.resetModules()
// boundaries (constants captured at import time would freeze the path).
function configDir(): string {
  return join(homedir(), ".ideaspaces");
}

function spacesFile(): string {
  return join(configDir(), "spaces.json");
}

export interface SpaceRecord {
  repo_id: string;
  slug: string;
  /** Username (personal space) or hostname (org space). Used for clone-URL construction. */
  namespace: string;
}

/** Map of absolute folder path → space record. */
export type SpacesMap = Record<string, SpaceRecord>;

export function loadSpaces(): SpacesMap {
  try {
    if (!existsSync(spacesFile())) return {};
    const raw = readFileSync(spacesFile(), "utf-8");
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
  if (!existsSync(configDir())) {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  }
  writeFileSync(spacesFile(), JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
}

export function findSpaceFor(absolutePath: string): SpaceRecord | null {
  return loadSpaces()[resolve(absolutePath)] ?? null;
}
