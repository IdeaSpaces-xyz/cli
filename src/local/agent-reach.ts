import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { repoRoot } from "../git.js";
import { loadMapNote } from "./map-note.js";
import { discoverSpaceMapFiles, inspectSpaceMapRoots } from "./space-map.js";

export interface DiscoverAgentReachOptions {
  povPath: string;
  mapFlag?: string;
  reachFlag?: string | string[];
  cwd?: string;
}

export interface AgentReachResult {
  addedDirs: string[];
  errors: string[];
}

/**
 * Resolve reachable directories for an agent run:
 * 1. The Space root enclosing the POV (if different from the POV).
 * 2. Local checkouts referenced by the POV's Map, the Space's Map, or explicit --map.
 * 3. Explicit directories passed via --reach.
 */
export function discoverAgentReach(opts: DiscoverAgentReachOptions): AgentReachResult {
  const errors: string[] = [];
  const baseCwd = opts.cwd ?? process.cwd();
  let pov: string;
  try {
    pov = realpathSync(opts.povPath);
  } catch (err) {
    return { addedDirs: [], errors: [`Cannot resolve POV ${opts.povPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  let spaceRoot: string | undefined;

  try {
    const candidate = repoRoot(pov);
    if (candidate !== pov) spaceRoot = candidate;
  } catch {
    // A standalone POV is valid without an enclosing git Space.
  }
  // A POV can itself be a nested Git repo. Its enclosing Space is the nearest
  // parent repository that actually owns _threads/, not the child's git top.
  if (!spaceRoot || !existsSync(join(spaceRoot, "_threads"))) {
    for (let parent = dirname(pov); parent !== dirname(parent); parent = dirname(parent)) {
      if (!existsSync(join(parent, "_threads"))) continue;
      try {
        if (repoRoot(parent) === parent) { spaceRoot = parent; break; }
      } catch {
        // Not a Git Space; keep walking ancestors.
      }
    }
  }

  const discoveredCheckouts: string[] = [];
  const mapsToInspect: { path: string; context: string }[] = [];

  if (opts.mapFlag) {
    mapsToInspect.push({ path: opts.mapFlag, context: opts.povPath });
  }

  const povMap = discoverSpaceMapFiles(opts.povPath);
  if (povMap) {
    mapsToInspect.push({ path: povMap.file, context: opts.povPath });
  }

  if (spaceRoot) {
    const spaceMap = discoverSpaceMapFiles(spaceRoot);
    if (spaceMap) {
      mapsToInspect.push({ path: spaceMap.file, context: spaceRoot });
    }
  }

  for (const item of mapsToInspect) {
    try {
      const loaded = loadMapNote(item.path, item.context);
      const inspected = inspectSpaceMapRoots(loaded.map.roots, item.context);
      for (const root of inspected) {
        if (root.checkoutPath && existsSync(root.checkoutPath) && statSync(root.checkoutPath).isDirectory()) {
          try {
            discoveredCheckouts.push(realpathSync(root.checkoutPath));
          } catch {
            discoveredCheckouts.push(root.checkoutPath);
          }
        }
      }
    } catch (err) {
      if (item.path === opts.mapFlag) {
        errors.push(`Cannot grant reach from --map ${item.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // A broken optional discovered Map cannot authorize a checkout.
    }
  }

  const explicitReach: string[] = [];
  if (opts.reachFlag) {
    for (const raw of (Array.isArray(opts.reachFlag) ? opts.reachFlag : [opts.reachFlag]).map((s) => s.trim()).filter(Boolean)) {
      const resolved = isAbsolute(raw) ? raw : resolve(baseCwd, raw);
      try {
        const canonical = realpathSync(resolved);
        if (!statSync(canonical).isDirectory()) throw new Error("directory not found");
        explicitReach.push(canonical);
      } catch {
        errors.push(`Refusing reach path ${raw}: directory not found.`);
      }
    }
  }

  const allAdded = [spaceRoot, ...discoveredCheckouts, ...explicitReach];
  const uniqueAddedDirs = [...new Set(allAdded.filter((d): d is string => Boolean(d) && d !== pov))];
  return { addedDirs: uniqueAddedDirs, errors };
}
