/**
 * The Space's Map derived from what is here, by type (Home's Agreement: "The Space's own Map is
 * derived by the CLI from what is here, by type"). Every repository in the start and within two
 * levels of it, each read for its identity, its HEAD, its remote, what Git does not have committed,
 * its kind from the Agreement's `agreement: <kind>:repo:<id>` line, its name and summary, and
 * whether it holds Threads. A curated `*.map.md` at the start, when there is one, is compared:
 * which roots it lists that are not here, and which repositories are here that it does not list.
 * Read-only.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { buildMap, parseFrontmatter, type MapBlock } from "@ideaspaces/protocol";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";
import { checkoutRootNodeId, inspectSpaceMap } from "./space-map.js";

const SKIPPED = new Set(["node_modules", ".git", "_threads", "_agent", "_assets", "_scratch", "dist", "bundle"]);
export const REPO_SEARCH_DEPTH = 2;
export const REPO_SEARCH_LIMIT = 2_000;

export interface SpaceRepo {
  /** Zero-based ordinal, the Map root index. */
  root: number;
  path: string;
  /** Forward-slash path under the start; "." for the start itself. */
  label: string;
  /** The Agreement's kind, from `agreement: <kind>:repo:<id>`; null when the Agreement declares none. */
  kind: string | null;
  name: string | null;
  summary: string | null;
  root_node_id: string | null;
  sha: string | null;
  origin: string | null;
  /** Files Git does not have committed, counted. */
  uncommitted: number;
  threads: number | null;
  /** Whether the start's curated Map lists this repository, when there is one. */
  in_map?: boolean;
}

export interface SpaceRepos {
  schema: "ideaspaces.map.repos.v1";
  kind: "repos";
  start: string;
  /** The curated Map compared against, when the start has one. */
  curated: { file: string; roots: number; missing_here: string[]; not_listed: string[] } | null;
  repos: SpaceRepo[];
  by_kind: Record<string, number>;
  map: MapBlock | null;
  map_status: "available" | "partial" | "projection_pending";
  /** Repositories the Map cannot carry (no identity or no HEAD), by label. */
  unidentified: string[];
  warnings: string[];
  complete: boolean;
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync(gitBinary(), args, { cwd, encoding: "utf8", env: sanitizedGitEnvironment({ GIT_OPTIONAL_LOCKS: "0" }), maxBuffer: 64 * 1024 * 1024, timeout: 8_000 });
  return result.status === 0 ? result.stdout : null;
}

/** Repositories in the start and within REPO_SEARCH_DEPTH below it; the start first when it is one. */
export function findRepositories(start: string, warnings: string[]): string[] {
  const canonical = realpathSync(start);
  const found: string[] = [];
  if (existsSync(join(canonical, ".git"))) found.push(canonical);
  let visited = 0;
  let capped = false;
  const walk = (dir: string, level: number) => {
    if (level > REPO_SEARCH_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      if (name.startsWith(".") || SKIPPED.has(name)) continue;
      if (visited++ > REPO_SEARCH_LIMIT) { capped = true; return; }
      const child = join(dir, name);
      let isDirectory = false;
      try { isDirectory = lstatSync(child).isDirectory(); } catch { continue; }
      if (!isDirectory) continue;
      if (existsSync(join(child, ".git"))) found.push(child);
      else walk(child, level + 1);
    }
  };
  walk(canonical, 1);
  if (capped) warnings.push(`the search for repositories stopped at ${REPO_SEARCH_LIMIT} folders; some may be missing.`);
  return found;
}

function agreementFacts(dir: string): { kind: string | null; name: string | null; summary: string | null } {
  const file = join(dir, "_agent", "agreement.md");
  let fm: Record<string, unknown> | null = null;
  if (existsSync(file)) {
    try { fm = parseFrontmatter(readFileSync(file, "utf8")); } catch { fm = null; }
  }
  const line = typeof fm?.agreement === "string" ? fm.agreement : null;
  const kind = line ? (/^([a-z][a-z0-9-]*):repo:/.exec(line)?.[1] ?? null) : null;
  let name = typeof fm?.name === "string" ? fm.name.replace(/^Agreement\s*[—-]\s*/, "") : null;
  let summary = typeof fm?.summary === "string" ? fm.summary : null;
  if (name === null || summary === null) {
    const readme = join(dir, "README.md");
    if (existsSync(readme)) {
      try {
        const rfm = parseFrontmatter(readFileSync(readme, "utf8"));
        name ??= typeof rfm?.name === "string" ? rfm.name : null;
        summary ??= typeof rfm?.summary === "string" ? rfm.summary : null;
      } catch { /* a README that does not parse adds nothing */ }
    }
  }
  return { kind, name, summary };
}

export function assembleSpaceRepos(start: string): SpaceRepos {
  const canonical = realpathSync(start);
  const warnings: string[] = [];
  const paths = findRepositories(canonical, warnings);
  if (!paths.length) throw new Error(`No repository in ${start} or within ${REPO_SEARCH_DEPTH} levels of it.`);
  let curated: ReturnType<typeof inspectSpaceMap> = null;
  try { curated = inspectSpaceMap(canonical); } catch (error) { warnings.push(`the curated Map at the start could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  const curatedIds = new Set((curated?.roots ?? []).map((root) => root.rootNodeId).filter((id): id is string => typeof id === "string"));
  const repos: SpaceRepo[] = paths.map((path, index) => {
    const label = path === canonical ? "." : relative(canonical, path).split("\\").join("/");
    const facts = agreementFacts(path);
    const status = git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const uncommitted = status === null ? 0 : status.split("\0").filter(Boolean).length;
    if (status === null) warnings.push(`${label}: Git could not report its status.`);
    const rootNodeId = checkoutRootNodeId(path);
    const threadsDir = join(path, "_threads");
    let threads: number | null = null;
    if (existsSync(threadsDir)) {
      try { threads = readdirSync(threadsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length; } catch { threads = null; }
    }
    return {
      root: index, path, label, ...facts, root_node_id: rootNodeId,
      sha: git(path, ["rev-parse", "--verify", "--quiet", "HEAD"])?.trim() ?? null,
      origin: git(path, ["remote", "get-url", "origin"])?.trim() ?? null,
      uncommitted, threads,
      ...(curated ? { in_map: rootNodeId !== null && curatedIds.has(rootNodeId) } : {}),
    };
  });
  const hereIds = new Set(repos.map((repo) => repo.root_node_id).filter((id): id is string => id !== null));
  const curatedSummary = curated ? {
    file: curated.file, roots: curated.roots.length,
    missing_here: curated.roots.filter((root) => !(root.rootNodeId && hereIds.has(root.rootNodeId))).map((root) => root.rootNodeId ?? root.repo ?? `root ${root.rootIndex}`),
    not_listed: repos.filter((repo) => repo.in_map === false).map((repo) => repo.label),
  } : null;
  const byKind: Record<string, number> = {};
  for (const repo of repos) byKind[repo.kind ?? "untyped"] = (byKind[repo.kind ?? "untyped"] ?? 0) + 1;
  const { map, map_status, unidentified, mapIndex } = mapOfRoots(repos, canonical, warnings);
  const built = map ? buildMap({
    roots: map.roots,
    members: repos.filter((repo) => mapIndex.has(repo.root)).map((repo) => ({ root: mapIndex.get(repo.root)!, position: ".", depth: "summary" as const, ...(repo.name || repo.summary ? { disclosure: { ...(repo.name ? { name: repo.name } : {}), ...(repo.summary ? { summary: repo.summary } : {}) } } : {}) })),
  }) : null;
  if (built && built.status !== "valid") warnings.push(`the derived Map did not validate: ${built.issues.map((issue) => `${issue.path} (${issue.code})`).join(", ")}`);
  return {
    schema: "ideaspaces.map.repos.v1", kind: "repos", start: canonical, curated: curatedSummary, repos, by_kind: byKind,
    map: built?.status === "valid" ? built.map : null, map_status, unidentified, warnings, complete: warnings.length === 0,
  };
}

export interface RootsMap {
  /** The Map's roots: the repositories with an identity and a HEAD, in start order; null when none has both. */
  map: { roots: Array<{ root_node_id: string; sha: string; name: string }> } | null;
  /** available: every repository is in the Map; partial: some are listed by name beside it; projection_pending: none could be. */
  map_status: "available" | "partial" | "projection_pending";
  /** The repositories the Map cannot carry (no identity, or no HEAD), by label, as such. */
  unidentified: string[];
  /** Repository ordinal → Map root ordinal, for members. */
  mapIndex: Map<number, number>;
}

/**
 * The Map a set of repositories makes. The protocol's Map carries only roots with an identity
 * (buildMap: missing_root_identity), so the answer carries the identified ones and lists the rest by
 * name beside it: the hits, Threads or repositories of an unidentified root stand on their own.
 */
export function mapOfRoots(repos: Array<{ root: number; label: string; root_node_id: string | null; sha: string | null }>, start: string, warnings: string[]): RootsMap {
  const carried = repos.filter((repo) => repo.root_node_id && repo.sha);
  const unidentified = repos.filter((repo) => !(repo.root_node_id && repo.sha)).map((repo) => repo.label);
  const mapIndex = new Map(carried.map((repo, index) => [repo.root, index]));
  const roots = carried.map((repo) => ({ root_node_id: repo.root_node_id!, sha: repo.sha!, name: repo.label === "." ? basename(start) : repo.label.split("/").pop()! }));
  // Two roots may share a folder name (agents/x and clients/x): names are local to the Map and must be unique.
  const seen = new Map<string, number>();
  for (const root of roots) { const n = (seen.get(root.name) ?? 0) + 1; seen.set(root.name, n); if (n > 1) root.name = `${root.name}-${n}`; }
  if (unidentified.length && carried.length) warnings.push(`${unidentified.length} repositor${unidentified.length === 1 ? "y has" : "ies have"} no identity or no HEAD and stand${unidentified.length === 1 ? "s" : ""} outside the portable Map: ${unidentified.join(", ")}.`);
  return { map: carried.length ? { roots } : null, map_status: !carried.length ? "projection_pending" : unidentified.length ? "partial" : "available", unidentified, mapIndex };
}

export function renderSpaceRepos(space: SpaceRepos): string {
  const lines = [`Space — ${space.start} (${space.repos.length} repositor${space.repos.length === 1 ? "y" : "ies"} by type: ${Object.entries(space.by_kind).map(([kind, count]) => `${kind} ${count}`).join(", ")})`];
  const kinds = [...new Set(space.repos.map((repo) => repo.kind ?? "untyped"))];
  for (const kind of kinds) {
    lines.push("", `${kind}:`);
    for (const repo of space.repos.filter((candidate) => (candidate.kind ?? "untyped") === kind)) {
      const facts = [
        repo.root_node_id ?? "no identity", repo.sha ? `@ ${repo.sha.slice(0, 12)}` : "no HEAD",
        repo.origin ? "remote" : "no remote",
        repo.uncommitted ? `${repo.uncommitted} uncommitted` : "clean",
        ...(repo.threads !== null ? [`${repo.threads} Thread${repo.threads === 1 ? "" : "s"}`] : []),
        ...(repo.in_map === false ? ["not in the curated Map"] : []),
      ];
      lines.push(`  [${repo.root}] ${repo.label}  ${repo.name ?? "(no name)"} · ${facts.join(" · ")}`);
      if (repo.summary) lines.push(`      ${repo.summary.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  if (space.curated) {
    lines.push("", `Curated Map ${space.curated.file}: ${space.curated.roots} roots${space.curated.missing_here.length ? `; listed but not here: ${space.curated.missing_here.join(", ")}` : ""}${space.curated.not_listed.length ? `; here but not listed: ${space.curated.not_listed.join(", ")}` : ""}${!space.curated.missing_here.length && !space.curated.not_listed.length ? "; the same repositories" : ""}`);
  }
  if (space.warnings.length) lines.push("", `Warnings (${space.warnings.length}):`, ...space.warnings.map((warning) => `  ${warning}`));
  lines.push("", `Map: ${mapStatusLine(space.map_status, space.unidentified, "repositories")}`);
  return lines.join("\n");
}

/** One line a reader can act on: what the Map carries and what stands outside it, by name. */
export function mapStatusLine(status: RootsMap["map_status"], unidentified: string[], what: string): string {
  if (status === "available") return `portable (every ${what.replace(/ies$/, "y").replace(/s$/, "")} identified and pinned at HEAD)`;
  if (status === "partial") return `partial: the identified ${what} are pinned at HEAD; without identity or HEAD, standing outside it: ${unidentified.join(", ")}`;
  return `projection pending (no ${what.replace(/ies$/, "y").replace(/s$/, "")} has an identity and a HEAD); everything stands on its own`;
}
