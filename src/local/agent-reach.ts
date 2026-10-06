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
  warnings: string[];
}

/**
 * Resolve reachable directories for an agent run:
 * 1. The Space root enclosing the POV (if different from the POV).
 * 2. Local checkouts referenced by the POV's Map, the Space's Map, or explicit --map.
 * 3. Explicit directories passed via --reach.
 */
export function discoverAgentReach(opts: DiscoverAgentReachOptions): AgentReachResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const baseCwd = opts.cwd ?? process.cwd();
  let pov: string;
  try {
    pov = realpathSync(opts.povPath);
  } catch (err) {
    return { addedDirs: [], warnings, errors: [`Cannot resolve POV ${opts.povPath}: ${err instanceof Error ? err.message : String(err)}`] };
  }
  let spaceRoot: string | undefined;
  let nestedRepo = true;
  try {
    const candidate = repoRoot(pov);
    nestedRepo = candidate === pov;
    if (!nestedRepo && existsSync(join(candidate, "_threads"))) spaceRoot = candidate;
  } catch {
    // A standalone POV may be under a Space; inspect only its nearest parent Git root.
  }
  // A POV can itself be a nested Git repo. Stop at the FIRST parent Git root;
  // never borrow reach from a more distant dotfiles or unrelated ancestor repo.
  if (nestedRepo) {
    for (let parent = dirname(pov); parent !== dirname(parent); parent = dirname(parent)) {
      try {
        if (repoRoot(parent) !== parent) continue;
        if (existsSync(join(parent, "_threads"))) spaceRoot = parent;
        break;
      } catch {
        // Keep walking until the first parent Git root or filesystem root.
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
        if (!root.checkoutPath) {
          warnings.push(`Map ${item.path}: no local checkout for ${root.rootNodeId ?? root.root.name ?? "unnamed root"}; not added to reach.`);
          continue;
        }
        try {
          if (!statSync(root.checkoutPath).isDirectory()) throw new Error("not a directory");
          discoveredCheckouts.push(realpathSync(root.checkoutPath));
        } catch (err) {
          warnings.push(`Map ${item.path}: checkout ${root.checkoutPath} unavailable (${err instanceof Error ? err.message : String(err)}); not added to reach.`);
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (item.path === opts.mapFlag) errors.push(`Cannot grant reach from --map ${item.path}: ${reason}`);
      else warnings.push(`Could not discover reach from Map ${item.path}: ${reason}`);
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
  return { addedDirs: uniqueAddedDirs, errors, warnings };
}
