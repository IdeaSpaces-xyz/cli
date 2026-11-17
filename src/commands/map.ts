/**
 * `ideaspaces map [<repo>]` — derive a local Content Map without a contract or network,
 * or display a curated Space Map (*.map.md) at the position.
 *
 * When a curated `*.map.md` (e.g. `home.map.md`) is present at the position,
 * `map` recognises it as the Space's curated Map, loads it through `local/map-note.ts`,
 * and reports drift between each root's pin and the checkout's HEAD.
 *
 * Without a `.map.md`, `map` derives a local Content Map from the working tree.
 */

import {
  assembleContentTree,
  buildMap,
  gitState,
  projectContentTreeMembers,
  readRepositoryImage,
  resolveRepoRoot,
  type ContentAwarenessTree,
  type ContentTreeDepth,
  type ProjectedContentTreeMember,
} from "@ideaspaces/protocol";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { MAP_DEPTHS, type MapDepth } from "@ideaspaces/protocol";
import { parseBool } from "../argv.js";
import { inspectPortableLocalRoot } from "../local-map-root.js";
import { loadMapOrientation } from "../local/map-orientation.js";
import { inspectSpaceMap } from "../local/space-map.js";
import { assembleThreadTree, parseWhere, PROBLEM_CODES, PROBLEM_DEFINITIONS, renderThreadTree, type WhereFilter } from "../local/thread-tree.js";
import { assembleSpaceRepos, mapOfRoots, mapStatusLine, renderSpaceRepos, type SpaceRepos } from "../local/space-repos.js";
import { searchCorpus } from "./search.js";
import { createOutput, type Output } from "../output.js";
import type { CommandDef } from "../types.js";
import { MAP_SELECT_USAGE, runMapSelection } from "./map-selection.js";
import { MAP_EDIT_USAGE, runMapEdit } from "./map-edit.js";

function parseDepth(value: string | boolean | undefined): ContentTreeDepth | null {
  if (value === undefined) return 1;
  if (typeof value !== "string") return null;
  if (value.toLowerCase() === "full") return "full";
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : null;
}

function humanMember(projected: ProjectedContentTreeMember): string {
  const { member, presentation } = projected;
  const suffix = presentation.kind === "directory" ? "/" : "";
  const summary = member.disclosure?.summary;
  return `  ${(member.depth ?? "unspecified").padEnd(8)} ${member.position}${suffix}${summary ? ` — ${summary}` : ""}`;
}

function emptyTree(): ContentAwarenessTree {
  return { placement: "head", totalMarkdownFiles: 0, entries: [] };
}

/** The flags that belong to `--kind threads`; without it they are refused, never ignored. */
const TREE_FLAGS = ["levels", "where", "problems", "since", "as-of"] as const;
const KINDS = "threads (the Thread tree) or repos (the Space's repositories by type)";

/** `--kind <k>` or `--query <q>`: the Space read by kind, or searched; each answers as a Map. */
async function runByKind(args: string[], flags: Record<string, string | boolean>, output: Output): Promise<number> {
  if (flags.kind === true) { output.error(`--kind needs a value: ${KINDS}.`); return 1; }
  if (flags.orientation !== undefined || flags.budget !== undefined) {
    output.error("--orientation and --budget read a curated Map note; omit them with --kind or --query.");
    return 1;
  }
  const start = resolve((args[0] ?? ".").trim() || ".");
  if (!existsSync(start) || !statSync(start).isDirectory()) {
    output.error(`Not a directory: ${start}. Give the Space root (or any folder whose repositories are within two levels of it).`);
    return 1;
  }
  if (flags.query !== undefined) {
    if (flags.kind !== undefined) { output.error("--query searches the whole Space under the start; omit --kind."); return 1; }
    for (const flag of TREE_FLAGS) if (flags[flag] !== undefined) { output.error(`--${flag} belongs to --kind threads; a search takes --limit.`); return 1; }
    return runQuery(start, flags, output);
  }
  if (flags.limit !== undefined) { output.error("--limit bounds a search (--query); the tree is bounded by --levels and --where."); return 1; }
  if (flags.kind === "repos") {
    for (const flag of TREE_FLAGS) if (flags[flag] !== undefined) { output.error(`--${flag} belongs to --kind threads; the Space by type takes no filter.`); return 1; }
    if (flags.depth !== undefined) { output.error("--kind repos reads each repository at the summary rung; omit --depth."); return 1; }
    try {
      const space = assembleSpaceRepos(start);
      output.result(space, renderSpaceRepos(space));
      return 0;
    } catch (error) {
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (flags.kind !== "threads") {
    output.error(`--kind ${String(flags.kind)} is not a kind this map reads; it is ${KINDS}. Search is --query <words>.`);
    return 1;
  }
  return runThreadTree(start, flags, output);
}

/**
 * `ideaspaces map <start> --query <words>`: a search over the Space, answered as a Map. The roots are
 * the repositories under the start, the members the hits at their positions, in rank order.
 */
async function runQuery(start: string, flags: Record<string, string | boolean>, output: Output): Promise<number> {
  const raw = typeof flags.query === "string" ? flags.query.trim() : "";
  if (!raw) { output.error("--query needs words or a filter, for example --query 'onboarding tag:desktop'. Run ideaspaces search --help for the query syntax."); return 1; }
  let limit = 20;
  if (flags.limit !== undefined) {
    if (typeof flags.limit !== "string" || !/^[1-9][0-9]*$/.test(flags.limit)) { output.error("--limit takes a whole number of hits, 1 or more."); return 1; }
    limit = Number(flags.limit);
  }
  try {
    const space: SpaceRepos = assembleSpaceRepos(start);
    const searched = await searchCorpus(space.repos.map((repo) => repo.path), raw, { limit, threads: true });
    const byPath = new Map(space.repos.map((repo) => [realpathSync.native(repo.path), repo]));
    const results = searched.results.map((hit) => {
      const repo = hit.root ? byPath.get(realpathSync.native(hit.root)) : undefined;
      return { ...hit, root: repo?.label ?? hit.root ?? null, root_index: repo?.root ?? null };
    });
    // The Map carries the hits of identified repositories; a hit in an unidentified one stays in results and
    // its repository is named beside the Map, as such (buildMap takes no root without identity).
    const { map: rootsMap, map_status, unidentified, mapIndex } = mapOfRoots(space.repos, space.start, []);
    const members = results.flatMap((hit) => hit.root_index === null || !mapIndex.has(hit.root_index) ? [] : [{
      root: mapIndex.get(hit.root_index)!, position: hit.path, depth: "summary" as const,
      disclosure: { ...(hit.title ? { name: hit.title } : {}), ...(hit.summary ? { summary: hit.summary } : {}) },
    }]);
    const built = rootsMap ? buildMap({ roots: rootsMap.roots, members }) : null;
    const map = built?.status === "valid" ? built.map : null;
    const outside = results.filter((hit) => hit.root_index === null || !mapIndex.has(hit.root_index)).length;
    const warnings = [...space.warnings, ...searched.roots.flatMap((row) => [...(row.error ? [`${row.root}: ${row.error}`] : []), ...(row.warnings ?? []).map((warning) => `${row.root}: ${warning}`)])];
    const data = {
      schema: "ideaspaces.map.query.v1", kind: "query", start: space.start, query: raw, limit,
      scanned: searched.scanned, matched: searched.matched, total: results.length,
      roots: space.repos.map((repo) => { const row = searched.roots.find((candidate) => realpathSync.native(candidate.root) === realpathSync.native(repo.path)); return { root: repo.root, label: repo.label, root_node_id: repo.root_node_id, sha: repo.sha, listed: row?.listed ?? 0, scanned: row?.scanned ?? 0, ...(row?.error ? { error: row.error } : {}) }; }),
      results, members, map, map_status, unidentified, hits_outside_map: outside, warnings, complete: searched.complete && space.complete,
    };
    const lines = [`Search — "${raw}" under ${space.start}: ${results.length} hit${results.length === 1 ? "" : "s"} (${searched.matched} matched, ${searched.scanned} files read in ${space.repos.length} repositor${space.repos.length === 1 ? "y" : "ies"})`];
    for (const hit of results) {
      lines.push(`  [${hit.root_index ?? "?"}] ${hit.path}${hit.line ? `:${hit.line}` : ""} — ${hit.title}${hit.summary ? ` — ${hit.summary.replace(/\s+/g, " ").slice(0, 160)}` : ""}`);
      if (hit.snippet) lines.push(`      ${hit.snippet.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    if (warnings.length) lines.push("", `Warnings (${warnings.length}):`, ...warnings.map((warning) => `  ${warning}`));
    lines.push("", `Map: ${mapStatusLine(map_status, unidentified, "repositories")}${outside ? `; ${outside} hit${outside === 1 ? "" : "s"} outside the Map, listed above` : ""}`);
    output.result(data, lines.join("\n"));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * `ideaspaces map <start> --kind threads`: the Thread tree of the Space under the start, as a Map.
 * Every `_threads/` in the start and in the repositories within two levels of it; each Thread by
 * the protocol's state rule; parents resolved across all of them; a rung per member; `--levels`
 * down the tree; `--problems` named and defined; `--since` and `--as-of` through the time rule.
 */
async function runThreadTree(start: string, flags: Record<string, string | boolean>, output: Output): Promise<number> {
  let depth: MapDepth = "name";
  if (flags.depth !== undefined) {
    if (typeof flags.depth !== "string" || !MAP_DEPTHS.includes(flags.depth as MapDepth)) {
      output.error("--depth with --kind threads is a rung: name, summary, children, surface or full.");
      return 1;
    }
    depth = flags.depth as MapDepth;
  }
  let levels: number | "all" = "all";
  if (flags.levels !== undefined) {
    const parsed = typeof flags.levels === "string" ? Number(flags.levels) : NaN;
    if (flags.levels === "all") levels = "all";
    else if (typeof flags.levels === "string" && /^[1-9][0-9]*$/.test(flags.levels) && Number.isSafeInteger(parsed)) levels = parsed;
    else { output.error("--levels must be a positive whole number of tree levels below the roots, or all."); return 1; }
  }
  let where: WhereFilter | undefined;
  if (flags.where !== undefined) {
    if (typeof flags.where !== "string") { output.error("--where requires a value: open, closed, holder:<name>, no-holder or stale:<date>."); return 1; }
    try { where = parseWhere(flags.where); } catch (error) { output.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  for (const flag of ["since", "as-of"] as const) {
    if (flags[flag] !== undefined && (typeof flags[flag] !== "string" || !flags[flag].trim())) {
      output.error(`--${flag} requires a value: an ISO date or instant, an entry id, or an entry's filename.`);
      return 1;
    }
  }
  const problems = flags.problems !== undefined && parseBool(flags.problems);
  try {
    const tree = assembleThreadTree(start, {
      levels, depth, where, problems,
      ...(typeof flags.since === "string" ? { since: flags.since.trim() } : {}),
      ...(typeof flags["as-of"] === "string" ? { asOf: flags["as-of"].trim() } : {}),
    });
    output.result(tree, renderThreadTree(tree));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export const mapCommand: CommandDef = {
  name: "map",
  description: "Display a curated Space Map (*.map.md), derive a local Content Map, map the Thread tree or the Space's repositories by type, or search the Space as a Map",
  usage: `ideaspaces map [<folder|map-note>] [--depth <1..4|full>] [--json]\n       ideaspaces map [<start>] --kind threads [--levels <n|all>] [--depth name|summary|children|surface|full] [--where open|closed|holder:<name>|no-holder|stale:<date>] [--problems] [--since <date|id|file>] [--as-of <date|id|file>] [--json]\n       ideaspaces map [<start>] --kind repos [--json]\n       ideaspaces map [<start>] --query <words> [--limit <n>] [--json]\n       ideaspaces map <map-note> --orientation [--budget <chars>] [--json]\n       ${MAP_EDIT_USAGE}\n       ${MAP_SELECT_USAGE}`,
  help: "--kind threads maps the Thread tree: every _threads/ in the start and in the repositories within two levels of it (Home keeps its repos in agents/, knowledge/, clients/), each Thread by the protocol's state rule (its name from the newest reframe, else the opening post; its parent from the newest post that set one, else the Agreement, else the opening), parents resolved across all of those roots. --levels bounds how far down the tree (default all); --depth is the rung per member (default name; summary adds the summary, holder, about and current Map; children adds the child slugs; surface and full add the five newest posts as lines). --where lists only matching Threads, flat, with each one's parent; stale:<date> is an open Thread with no post since that date. --since lists the Threads with a post after the cursor, with the count; --as-of reads every Thread as it stood at the cursor, while the roots' sha, their uncommitted files and the portable map still describe the working tree now. A cursor is an ISO date or instant, an entry id, or an entry's filename.\n\n" +
    `--problems names what is wrong, each defined in one line, over the whole tree before any filter:\n${PROBLEM_CODES.map((code) => `  ${code}: ${PROBLEM_DEFINITIONS[code]}`).join("\n")}\n\n` +
    "--kind repos maps the Space by type: every repository in the start and within two levels of it, each with its identity, HEAD, remote, uncommitted files, its kind from the Agreement's `agreement: <kind>:repo:<id>` line (agent, knowledge, code, …), its name and summary, and its Threads; a curated *.map.md at the start is compared, naming what it lists that is not here and what is here that it does not list. This is the Space's own Map, derived from what is here, which the hand-kept Map file stands in for until it is retired.\n\n" +
    "--query <words> searches the Space: every repository under the start as one corpus, with ideaspaces search's syntax (words, tag:, in:, kind:, author:, has:map, post-kind:), Threads included, --limit hits (default 20), answered as a Map whose members are the hits in rank order.\n\n" +
    "Every answer is a Map: roots pinned at HEAD with their uncommitted files counted, members at a rung. `map` carries the roots with an identity and a HEAD; a root without either stands outside it, named in `unidentified` (map_status partial), its Threads or hits still in the answer. Nothing is written.",
  subcommands: {
    ...Object.fromEntries(["create", "add", "remove"].map((verb) => [verb,
      MAP_EDIT_USAGE.split("\n").map((line) => line.trim()).filter((line) => line.startsWith(`ideaspaces map ${verb} `)).join("\n       ")])),
    select: MAP_SELECT_USAGE,
  },
  helpArgument: () => true, // A folder/Map name is also valid here.
  examples: [
    "ideaspaces map . --json",
    "ideaspaces map . --kind threads --levels all --depth name --problems  # the Thread tree of the Space, one call, with what is wrong named",
    "ideaspaces map . --kind threads --where stale:2026-11-01 --depth summary  # open Threads with no post since that date, flat, with their parents",
    "ideaspaces map . --kind threads --since 2026-11-14 --json  # the Threads that moved since, with how many posts",
    "ideaspaces map . --kind threads --as-of 2026-11-01  # the tree as it stood then: names, parents and closed state as of that day",
    "ideaspaces map . --kind repos  # the Space by type: every repository here, its kind, identity, HEAD, remote, uncommitted files and Threads, against the curated Map",
    "ideaspaces map . --query 'progressive closure' --limit 10  # a search over the whole Space, answered as a Map of the hits",
    "ideaspaces map home.map.md --orientation",
    "ideaspaces map home.map.md --orientation --budget 8000 --json",
    "ideaspaces map create team.map.md --name Team --summary 'Team space'",
    "ideaspaces map add team.map.md thread:x_0123456789abcdef01234567 --depth summary",
    "ideaspaces map remove team.map.md 0 --if-match <file_sha>  # from map team.map.md --json",
    "ideaspaces map select notes/finding.md --hostname example.com --note-depth surface --json",
    "ideaspaces map ../research --depth 2 --json",
    "ideaspaces map ../research --depth full --json  # complete local Content tree",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    if (args[0] === "select") {
      return runMapSelection(args.slice(1), flags, global, output);
    }
    if (["create", "add", "remove"].includes(args[0])) {
      return runMapEdit(args, flags, global);
    }
    if (flags.kind !== undefined || flags.query !== undefined) return runByKind(args, flags, output);
    for (const flag of [...TREE_FLAGS, "limit"] as const) {
      if (flags[flag] !== undefined) {
        output.error(`--${flag} belongs to --kind threads (the Thread tree) or --query (a search); add one, or omit it for a content Map.`);
        return 1;
      }
    }
    const depth = parseDepth(flags.depth);
    if (depth === null) {
      output.error("Map depth must be 1, 2, 3, 4, or full: --depth <1..4|full>");
      return 1;
    }

    const orientation = flags.orientation !== undefined && parseBool(flags.orientation);
    if (flags.budget !== undefined && !orientation) {
      output.error("--budget requires --orientation");
      return 1;
    }
    if (flags.depth !== undefined && orientation) {
      output.error("--depth cannot be combined with --orientation; orientation reads members at their declared depths");
      return 1;
    }

    let budget: number | undefined;
    if (flags.budget !== undefined) {
      const raw = typeof flags.budget === "string" ? flags.budget.trim() : "";
      if (!raw || !/^\d+$/.test(raw)) {
        output.error("Invalid --budget: must be a positive integer");
        return 1;
      }
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        output.error("Invalid --budget: must be a positive integer");
        return 1;
      }
      budget = parsed;
    }

    const requested = resolve((args[0] ?? ".").trim() || ".");
    let target: string;
    let selectedFile: string | undefined;
    try {
      if (statSync(requested).isFile() && (basename(requested).endsWith(".map.md") || basename(requested) === "README.md")) {
        selectedFile = basename(requested);
        target = realpathSync.native(dirname(requested));
      } else if (statSync(requested).isDirectory()) {
        target = realpathSync.native(requested);
      } else {
        output.error(`Not a Map note or directory: ${requested}`);
        return 1;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      output.error(
        code === "ENOENT"
          ? `No such path: ${requested}`
          : `Cannot read ${requested}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }

    // 1. Check for a curated Space Map (*.map.md) at the target position
    let spaceMap: ReturnType<typeof inspectSpaceMap>;
    try {
      spaceMap = inspectSpaceMap(target, selectedFile);
    } catch (error) {
      output.error(`Could not open Space Map: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    if (orientation) {
      if (!spaceMap) {
        output.error(
          `A curated Map note (*.map.md) is required for --orientation: ${requested}\nPass an existing Map note: ideaspaces map <file.map.md> --orientation`,
        );
        return 1;
      }
      const mapRef = selectedFile ? resolve(target, selectedFile) : resolve(target, spaceMap.file);
      const resolvedRepoRoot = await resolveRepoRoot(target);
      const contextRoot = resolvedRepoRoot ? realpathSync.native(resolvedRepoRoot) : target;
      try {
        const orientationResult = await loadMapOrientation(mapRef, contextRoot, { budget });
        const data = {
          kind: "map-orientation",
          path: orientationResult.note.path,
          budget: orientationResult.budget,
          lowered: orientationResult.lowered,
          dropped: orientationResult.dropped,
          legend: orientationResult.legend,
          text: orientationResult.text,
        };
        output.result(data, orientationResult.text);
        return 0;
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    if (spaceMap) {
      // Each root with a checkout: its README's `image:`, checked by the protocol. Never fatal.
      const images = await Promise.all(spaceMap.roots.map((r) => rootImage(r.checkoutPath)));
      const data = {
        kind: "space-map",
        source: "curated-map-note",
        file: spaceMap.file,
        ...(spaceMap.otherFiles.length ? { other_files: spaceMap.otherFiles } : {}),
        path: spaceMap.note.path,
        file_sha: spaceMap.note.fileSha,
        name: spaceMap.note.name ?? null,
        summary: spaceMap.note.summary ?? null,
        roots: spaceMap.roots.map((r, i) => ({
          root_index: r.rootIndex,
          root_node_id: r.rootNodeId,
          repo: r.repo,
          sha: r.pinnedSha,
          status: r.status,
          drift: r.drift,
          head_sha: r.headSha,
          checkout_path: r.checkoutPath,
          ...images[i],
        })),
        members: spaceMap.members,
        map: spaceMap.note.map,
      };

      const lines: string[] = [`Space Map (${spaceMap.file}) — ${target}`];
      if (spaceMap.otherFiles.length > 0) {
        lines.push(
          `Note: Multiple Space Maps found (${[spaceMap.file, ...spaceMap.otherFiles].join(", ")}). Using ${spaceMap.file}.`,
        );
      }
      if (spaceMap.note.name) lines.push(`Name: ${spaceMap.note.name}`);
      if (spaceMap.note.summary) lines.push(`Summary: ${spaceMap.note.summary}`);

      lines.push(`Roots (${spaceMap.roots.length}${spaceMap.roots.length > 0 ? ", ordered" : ""}):`);
      if (spaceMap.roots.length === 0) {
        lines.push("  (empty Map)");
      } else {
        for (const r of spaceMap.roots) {
          const label = r.repo ?? r.rootNodeId ?? `root_${r.rootIndex}`;
          const mark = r.pinnedSha ? `[${r.status}] ` : "";
          const pin = r.pinnedSha ? ` @ ${r.pinnedSha}` : "";
          const detail = r.status === "moved" && r.headSha ? ` (head: ${r.headSha})` : "";
          lines.push(`  [${r.rootIndex}] ${mark}${label}${pin}${detail}`);
          const image = images[r.rootIndex];
          if (image.image) lines.push(`      image: ${image.image.path} (${image.image.media_type})`);
          else if (image.image_problem) lines.push(`      image: not shown (${image.image_problem.code}): ${image.image_problem.message}`);
        }
      }

      lines.push(`Members (${spaceMap.members.length}${spaceMap.members.length > 0 ? ", ordered" : ""}):`);
      if (spaceMap.members.length === 0) {
        lines.push("  (no members)");
      } else {
        for (const [index, member] of spaceMap.members.entries()) {
          const summary = member.summary ? ` — ${member.summary}` : "";
          if ("address" in member && typeof member.address === "string") {
            lines.push(
              `  [${index}] address="${member.address}" depth=${member.depth ?? "unspecified"}${summary}`,
            );
          } else if ("position" in member) {
            lines.push(
              `  [${index}] position="${member.position}" root=${member.root}${member.depth ? ` depth=${member.depth}` : ""}${summary}`,
            );
          }
        }
      }

      if (spaceMap.note.legend) {
        lines.push("Legend (user-authored prose):");
        for (const line of spaceMap.note.legend.split("\n")) {
          lines.push(`  | ${line}`);
        }
      }

      output.result(data, lines.join("\n"));
      return 0;
    }

    // 2. No *.map.md — derive a local Content tree
    const resolvedRepoRoot = await resolveRepoRoot(target);
    if (!resolvedRepoRoot) {
      output.error(`Not a Git repository: ${target}`);
      return 1;
    }
    const repoRoot = realpathSync.native(resolvedRepoRoot);
    if (repoRoot !== target) {
      output.error(`Not a repository root: ${target} (root is ${repoRoot})`);
      return 1;
    }

    const assembled = await Promise.all([
      assembleContentTree({ position: target, depth }),
      gitState(repoRoot),
    ]).catch((error: unknown) => {
      output.error(`Could not derive Map: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (!assembled) return 1;
    const [treeResult, state] = assembled;
    const tree = treeResult ?? emptyTree();
    const projection = projectContentTreeMembers(tree);
    // A Map root is addressed by stable identity. A declared checkout has one
    // before it is ever published; a hosted origin additionally earns the
    // canonical repo URL. Either stable identity form can anchor a portable
    // pinned Map, while remote usability remains a later consumer check.
    const markdownPositions = projection.members
      .filter(({ presentation }) => presentation.kind === "markdown")
      .map(({ member }) => member.position);
    let inspectedRoot: ReturnType<typeof inspectPortableLocalRoot>;
    try {
      inspectedRoot = inspectPortableLocalRoot(repoRoot, state.headSha, markdownPositions);
    } catch (error) {
      output.error(`Could not inspect Map root state: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const { root, portableRoot, dirty, localOnlyPaths } = inspectedRoot;
    const built = portableRoot
      ? buildMap({
          roots: [portableRoot],
          members: projection.members.map(({ member }) => member),
        })
      : null;
    const portableMap = built?.status === "valid" ? built.map : null;
    const portable = portableMap !== null;
    const complete = depth === "full" && projection.omittedEntries === undefined &&
      projection.members.every(({ presentation }) => presentation.omittedChildren === undefined);

    const data = {
      kind: "derived-map",
      source: "local-working-tree",
      depth,
      complete,
      portable,
      dirty,
      local_only_paths: localOnlyPaths,
      total_markdown_files: tree.totalMarkdownFiles,
      omitted_entries: projection.omittedEntries ?? 0,
      projection: {
        root,
        members: projection.members,
      },
      ...(portableMap ? { map: portableMap } : {}),
      ...(built?.status === "invalid" ? { map_issues: built.issues } : {}),
    };

    const rootLabel = root.repo ?? root.root_node_id ?? root.local_path;
    const lines = [
      `Derived Map (${depth}) — ${repoRoot}`,
      `Root: ${rootLabel}${root.sha ? ` @ ${root.sha}` : " (unborn HEAD)"}`,
      `State: ${portable
        ? "portable Map seed"
        : dirty
          ? "working tree differs from HEAD"
          : built?.status === "invalid"
            ? "portable Map validation failed (run with --json for map_issues)"
            : "local root has no portable identity"}`,
      `Members (${projection.members.length}; ${tree.totalMarkdownFiles} markdown files):`,
      ...projection.members.map(humanMember),
    ];
    output.result(data, lines.join("\n"));
    return 0;
  },
};

export interface RootImageFields {
  /** `null` when the checkout's README declares none, or the image can't be shown. */
  image: { path: string; absolute_path: string; media_type: string } | null;
  /** Present only when an image was declared and a check failed. The reader shows its default. */
  image_problem?: { code: string; declared?: string; message: string };
}

/**
 * The identity image of one Map root's checkout (protocol `readRepositoryImage`). A root with no
 * checkout has none; the protocol answers every I/O error as `unreadable`, never a failed Map read.
 */
export async function rootImage(checkoutPath: string | null | undefined): Promise<RootImageFields> {
  if (!checkoutPath) return { image: null };
  try {
    const read = await readRepositoryImage(checkoutPath);
    if (read.status === "ok") {
      return { image: { path: read.image.path, absolute_path: read.image.absolutePath, media_type: read.image.mediaType } };
    }
    if (read.status === "problem") {
      return {
        image: null,
        image_problem: { code: read.code, ...(read.declared !== undefined ? { declared: read.declared } : {}), message: read.message },
      };
    }
    return { image: null };
  } catch (error) {
    return {
      image: null,
      image_problem: { code: "unreadable", message: `README.md's image couldn't be read: ${error instanceof Error ? error.message : String(error)}` },
    };
  }
}
