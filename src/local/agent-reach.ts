import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { repoRoot } from "../git.js";
import { loadMapNote } from "./map-note.js";
import { discoverSpaceMapFiles, inspectSpaceMapRoots } from "./space-map.js";

export interface DiscoverAgentReachOptions {
  povPath: string;
  mapFlag?: string;
  reachFlag?: string;
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
  const pov = realpathSync(opts.povPath);
  let spaceRoot: string | undefined;

  try {
    const candidate = repoRoot(pov);
    if (candidate !== pov) spaceRoot = candidate;
  } catch {
    // A standalone POV is valid without an enclosing git Space.
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
    for (const raw of opts.reachFlag.split(",").map((s) => s.trim()).filter(Boolean)) {
      const resolved = isAbsolute(raw) ? raw : resolve(baseCwd, raw);
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        errors.push(`Refusing reach path ${raw}: directory not found.`);
        continue;
      }
      try {
        explicitReach.push(realpathSync(resolved));
      } catch (err) {
        errors.push(`Refusing reach path ${raw}: ${err instanceof Error ? err.message : String(err)}.`);
      }
    }
  }

  const allAdded = [spaceRoot, ...discoveredCheckouts, ...explicitReach];
  const uniqueAddedDirs = [...new Set(allAdded.filter((d): d is string => Boolean(d) && d !== pov))];
  return { addedDirs: uniqueAddedDirs, errors };
}
