/**
 * `ideaspaces map [<repo>]` — derive a local Content Map without a contract or network.
 *
 * This is deliberately separate from `navigate`: navigate is bounded ambient
 * orientation at a position, while map is explicit repository enumeration. The
 * protocol owns the one tree walker and its exclusion/summary semantics; this
 * command only projects those handles into the Map rung vocabulary.
 */

import {
  assembleContentTree,
  canonicalizeMapSpace,
  gitState,
  resolveRepoRoot,
  type ContentAwarenessTree,
  type ContentAwarenessTreeEntry,
  type ContentTreeDepth,
  type MapDepth,
} from "@ideaspaces/protocol";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ignoredPaths, originUrl, statusEntries } from "../git.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

interface DerivedMapRoot {
  local_path: string;
  sha: string | null;
  space?: string;
}

interface DerivedMapMember {
  space: 0;
  position: string;
  depth: MapDepth;
  kind: "directory" | "markdown";
  name: string;
  summary?: string;
  markdown_files?: number;
  omitted_children?: number;
}

function parseDepth(value: string | boolean | undefined): ContentTreeDepth | null {
  if (value === undefined) return 1;
  if (typeof value !== "string") return null;
  if (value.toLowerCase() === "full") return "full";
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 4 ? parsed : null;
}

function representation(entry: ContentAwarenessTreeEntry): MapDepth {
  if (entry.kind === "directory" && (entry.children?.length || entry.omittedChildren)) {
    return "children";
  }
  return entry.summary ? "summary" : "name";
}

function flatten(
  entries: readonly ContentAwarenessTreeEntry[],
  parent = "",
  members: DerivedMapMember[] = [],
): DerivedMapMember[] {
  for (const entry of entries) {
    const position = parent ? `${parent}/${entry.name}` : entry.name;
    members.push({
      space: 0,
      position,
      depth: representation(entry),
      kind: entry.kind,
      name: entry.name,
      ...(entry.summary ? { summary: entry.summary } : {}),
      ...(entry.markdownFiles === undefined ? {} : { markdown_files: entry.markdownFiles }),
      ...(entry.omittedChildren === undefined ? {} : { omitted_children: entry.omittedChildren }),
    });
    if (entry.children) flatten(entry.children, position, members);
  }
  return members;
}

function humanMember(member: DerivedMapMember): string {
  const suffix = member.kind === "directory" ? "/" : "";
  return `  ${member.depth.padEnd(8)} ${member.position}${suffix}${member.summary ? ` — ${member.summary}` : ""}`;
}

function emptyTree(): ContentAwarenessTree {
  return { totalMarkdownFiles: 0, entries: [] };
}

function localOnlyMarkdownPaths(paths: string[], root: string): string[] {
  const found: string[] = [];
  for (let offset = 0; offset < paths.length; offset += 200) {
    found.push(...ignoredPaths(paths.slice(offset, offset + 200), root));
  }
  return found;
}

export const mapCommand: CommandDef = {
  name: "map",
  description: "Derive a local repository Map at bounded or explicit full depth",
  usage: "ideaspaces map [<repo>] [--depth <1..4|full>] [--json]",
  examples: [
    "ideaspaces map . --json",
    "ideaspaces map ../research --depth 2 --json",
    "ideaspaces map ../research --depth full --json  # complete local Content tree",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    const depth = parseDepth(flags.depth);
    if (depth === null) {
      output.error("Map depth must be 1, 2, 3, 4, or full: --depth <1..4|full>");
      return 1;
    }

    const requested = resolve((args[0] ?? ".").trim() || ".");
    let target: string;
    try {
      if (!statSync(requested).isDirectory()) {
        output.error(`Not a directory: ${requested}`);
        return 1;
      }
      target = realpathSync.native(requested);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      output.error(
        code === "ENOENT"
          ? `No such path: ${requested}`
          : `Cannot read ${requested}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
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
    const members = flatten(tree.entries);
    const remote = originUrl(repoRoot);
    const normalized = remote ? canonicalizeMapSpace(remote) : null;
    const root: DerivedMapRoot = {
      local_path: repoRoot,
      sha: state.headSha,
      ...(normalized?.status === "valid" ? { space: normalized.space } : {}),
    };
    const markdownPositions = members
      .filter((member) => member.kind === "markdown")
      .map((member) => member.position);
    let localOnlyPaths: string[];
    let dirty: boolean;
    try {
      localOnlyPaths = localOnlyMarkdownPaths(markdownPositions, repoRoot);
      dirty = statusEntries(repoRoot).length > 0 || localOnlyPaths.length > 0;
    } catch (error) {
      output.error(`Could not inspect Map root state: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const portable = Boolean(root.space && root.sha && !dirty);
    const complete = depth === "full" && tree.omittedEntries === undefined &&
      members.every((member) => member.omitted_children === undefined);

    const data = {
      kind: "derived-map",
      source: "local-working-tree",
      depth,
      complete,
      portable,
      dirty,
      local_only_paths: localOnlyPaths,
      total_markdown_files: tree.totalMarkdownFiles,
      omitted_entries: tree.omittedEntries ?? 0,
      map: {
        roots: [root],
        members,
      },
    };

    const rootLabel = root.space ?? root.local_path;
    const lines = [
      `Derived Map (${depth}) — ${repoRoot}`,
      `Root: ${rootLabel}${root.sha ? ` @ ${root.sha}` : " (unborn HEAD)"}`,
      `State: ${portable
        ? "portable Map seed"
        : dirty
          ? "working tree differs from HEAD"
          : "local root has no portable remote identity"}`,
      `Members (${members.length}; ${tree.totalMarkdownFiles} markdown files):`,
      ...members.map(humanMember),
    ];
    output.result(data, lines.join("\n"));
    return 0;
  },
};
