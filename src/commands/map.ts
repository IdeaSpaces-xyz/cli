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
  resolveRepoRoot,
  type ContentAwarenessTree,
  type ContentTreeDepth,
  type ProjectedContentTreeMember,
} from "@ideaspaces/protocol";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { inspectPortableLocalRoot } from "../local-map-root.js";
import { inspectSpaceMap } from "../local/space-map.js";
import { createOutput } from "../output.js";
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

export const mapCommand: CommandDef = {
  name: "map",
  description: "Display a curated Space Map (*.map.md) or derive a local Content Map",
  usage: `ideaspaces map [<folder|map-note>] [--depth <1..4|full>] [--json]\n       ${MAP_EDIT_USAGE}\n       ${MAP_SELECT_USAGE}`,
  examples: [
    "ideaspaces map . --json",
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
    const depth = parseDepth(flags.depth);
    if (depth === null) {
      output.error("Map depth must be 1, 2, 3, 4, or full: --depth <1..4|full>");
      return 1;
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
    if (spaceMap) {
      const data = {
        kind: "space-map",
        source: "curated-map-note",
        file: spaceMap.file,
        ...(spaceMap.otherFiles.length ? { other_files: spaceMap.otherFiles } : {}),
        path: spaceMap.note.path,
        file_sha: spaceMap.note.fileSha,
        name: spaceMap.note.name ?? null,
        summary: spaceMap.note.summary ?? null,
        roots: spaceMap.roots.map((r) => ({
          root_index: r.rootIndex,
          root_node_id: r.rootNodeId,
          repo: r.repo,
          sha: r.pinnedSha,
          status: r.status,
          drift: r.drift,
          head_sha: r.headSha,
          checkout_path: r.checkoutPath,
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
