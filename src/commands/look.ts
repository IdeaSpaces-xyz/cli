/**
 * `ideaspaces look <path> [--depth <rung>]` — deepen exactly one local Content
 * target beneath its reference-only contract frame.
 *
 * The protocol owns all five Note/directory rung semantics and canonical text.
 * This adapter applies the CLI's Agreement-first selection policy and adds a
 * portable Map only when the local root is clean, pinned, and identified.
 */

import { resolve } from "node:path";
import {
  MAP_DEPTHS,
  assembleContentLook,
  buildMap,
  gitState,
  renderContentLook,
  type ContentLookManifest,
  type MapBlock,
  type MapDepth,
  type MapParseIssue,
  type GitState,
} from "@ideaspaces/protocol";
import { contractSourceFlag, preferredContractSource } from "../contract-source.js";
import {
  inspectPortableLocalRoot,
  type LocalProjectionRoot,
} from "../local-map-root.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const USAGE =
  "ideaspaces look <path> [--depth <name|summary|surface|children|full>] [--contract <foundation|agreement>] [--limit <n>] [--json]";

interface PortableProjection {
  root: LocalProjectionRoot;
  portable: boolean;
  dirty: boolean;
  localOnlyPaths: string[];
  map?: MapBlock;
  mapIssues?: MapParseIssue[];
  issue?: string;
}

function parseDepth(value: string | boolean | undefined): MapDepth | null {
  if (value === undefined) return "summary";
  return typeof value === "string" && MAP_DEPTHS.includes(value as MapDepth)
    ? value as MapDepth
    : null;
}

function parseLimit(value: string | boolean | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isRemoteAddress(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export const lookCommand: CommandDef = {
  name: "look",
  description: "Read one local Note or directory at a progressive-disclosure rung",
  usage: USAGE,
  examples: [
    "ideaspaces look notes/decision.md",
    "ideaspaces look notes/decision.md --depth children",
    "ideaspaces look research --depth full --json",
    "ideaspaces look . --contract foundation --depth summary",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    if (args.length !== 1 || !args[0]?.trim()) {
      output.error(`Usage: ${USAGE}`);
      return 1;
    }

    const raw = args[0].trim();
    if (isRemoteAddress(raw)) {
      output.error("Remote look is not available yet; use a local path.");
      return 1;
    }
    const depth = parseDepth(flags.depth);
    if (!depth) {
      output.error(`--depth must be one of: ${MAP_DEPTHS.join(", ")}`);
      return 1;
    }
    const limit = parseLimit(flags.limit);
    if (limit === null) {
      output.error("--limit must be a non-negative integer");
      return 1;
    }
    const selected = contractSourceFlag(flags.contract);
    if (selected.error) {
      output.error(selected.error);
      return 1;
    }

    const path = resolve(raw);
    let looked;
    try {
      const options = {
        position: path,
        depth,
        ...(selected.source ? { contractSource: selected.source } : {}),
        ...(limit !== undefined ? { maxChildren: limit } : {}),
      };
      looked = await assembleContentLook(options);
      // The protocol remains neutral. Agreement-first is explicit CLI policy.
      if (looked?.status === "contract_choice_required" && !selected.source) {
        const preferred = preferredContractSource(looked.availableSources);
        if (preferred) {
          looked = await assembleContentLook({ ...options, contractSource: preferred });
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      output.error(
        code === "ENOENT"
          ? `No such path: ${path}`
          : `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }

    if (!looked) {
      output.error(`Not a Content target: ${path}`);
      return 1;
    }
    if (looked.status !== "ok") {
      output.error(renderContentLook(looked));
      return 1;
    }

    let projection: PortableProjection;
    try {
      projection = await projectPortableMap(looked);
    } catch (error) {
      // Portability is stricter than local readability. If Git or identity
      // verification races or fails, retain the useful read and omit the Map.
      projection = {
        root: {
          local_path: looked.reference.position.repoRoot ?? looked.reference.spaceRoot,
          sha: null,
        },
        portable: false,
        dirty: true,
        localOnlyPaths: [],
        issue: `Could not verify a portable Map root: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const text = renderContentLook(looked);
    const data = {
      text,
      kind: looked.kind,
      source: "local-working-tree",
      depth,
      portable: projection.portable,
      dirty: projection.dirty,
      local_only_paths: projection.localOnlyPaths,
      reference: looked.reference,
      target: looked.target,
      projection: {
        root: projection.root,
        member: looked.target.member,
      },
      ...(projection.map ? { map: projection.map } : {}),
      ...(projection.mapIssues ? { map_issues: projection.mapIssues } : {}),
      ...(projection.issue ? { portability_issue: projection.issue } : {}),
    };
    output.result(data, `${text}\n\n${portabilityLine(projection)}`);
    return 0;
  },
};

export interface PortableProjectionDependencies {
  readGitState?: (repoRoot: string) => Promise<GitState>;
  reread?: typeof assembleContentLook;
}

export async function projectPortableMap(
  looked: ContentLookManifest,
  dependencies: PortableProjectionDependencies = {},
): Promise<PortableProjection> {
  const readGitState = dependencies.readGitState ?? gitState;
  const reread = dependencies.reread ?? assembleContentLook;
  const repoRoot = looked.reference.position.repoRoot;
  if (!repoRoot) {
    return {
      root: { local_path: looked.reference.spaceRoot, sha: null },
      portable: false,
      dirty: false,
      localOnlyPaths: [],
    };
  }

  const state = await readGitState(repoRoot);
  const observed = observedPaths(looked);
  const inspected = inspectPortableLocalRoot(repoRoot, state.headSha, observed);
  const { root, portableRoot, dirty, localOnlyPaths } = inspected;
  if (!portableRoot) {
    return { root, portable: false, dirty, localOnlyPaths };
  }

  // The target was read before the Git pin. Re-read the same representation
  // between two HEAD observations so a concurrent clean commit cannot pair
  // worktree disclosure with a different revision.
  const rechecked = await reread({
    position: looked.target.path,
    depth: looked.target.depth,
    ...(looked.reference.contractSource
      ? { contractSource: looked.reference.contractSource }
      : {}),
    ...(looked.target.children
      ? { maxChildren: looked.target.children.length }
      : {}),
  });
  const stateAfter = await readGitState(repoRoot);
  if (
    !rechecked ||
    rechecked.status !== "ok" ||
    rechecked.target.revision !== looked.target.revision ||
    stateAfter.headSha !== state.headSha
  ) {
    return {
      root,
      portable: false,
      dirty,
      localOnlyPaths,
      issue: "The target or Git HEAD changed while verifying the portable Map",
    };
  }

  const built = buildMap({
    roots: [portableRoot],
    members: [{ root: 0, ...looked.target.member }],
  });
  if (built.status === "invalid") {
    return {
      root,
      portable: false,
      dirty,
      localOnlyPaths,
      mapIssues: built.issues,
    };
  }
  return {
    root,
    portable: true,
    dirty,
    localOnlyPaths,
    map: built.map,
  };
}

function observedPaths(looked: ContentLookManifest): string[] {
  const { target } = looked;
  const paths = [target.position];
  if (target.kind === "directory") {
    // A missing README simply does not match check-ignore; naming the possible
    // surface avoids another filesystem read and its race window.
    paths.push(target.position === "." ? "README.md" : `${target.position}/README.md`);
    for (const child of target.children ?? []) {
      if (child.kind !== "section") paths.push(child.position);
    }
  }
  return [...new Set(paths)];
}

function portabilityLine(projection: PortableProjection): string {
  if (projection.portable) return `Map: portable at ${projection.root.sha}`;
  if (projection.issue) return `Map: local projection only — ${projection.issue}`;
  if (projection.mapIssues?.length) {
    return "Map: local projection only — portable Map validation failed (run with --json for map_issues)";
  }
  if (projection.dirty) {
    return projection.localOnlyPaths.length
      ? "Map: local projection only — observed Content is local-only or the working tree differs from HEAD"
      : "Map: local projection only — working tree differs from HEAD";
  }
  if (!projection.root.sha) return "Map: local projection only — the root has no committed pin";
  if (!projection.root.root_node_id) return "Map: local projection only — the root has no portable identity";
  return "Map: local projection only";
}
