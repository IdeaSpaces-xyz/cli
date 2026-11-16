/**
 * `ideaspaces look <path> [--depth <rung>]` — deepen exactly one local Content
 * target beneath its reference-only contract frame.
 *
 * `look <address> [--map <note>] [--at pin|head]` reads a Map member instead:
 * `@<root>//<position>` or `//<position>`, against the named Map or the
 * session's launch Map, at a commit, with no filesystem path. `look <path>
 * --pin <sha>` reads the caller's own checkout at an authored commit.
 *
 * The protocol owns all five Note/directory rung semantics and canonical text.
 * This adapter applies the CLI's Agreement-first selection policy and adds a
 * portable Map only when the local root is clean, pinned, and identified.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
import { agreementFlag, contractSourceFlag, preferredContractSource } from "../contract-source.js";
import {
  inspectPortableLocalRoot,
  type LocalProjectionRoot,
} from "../local-map-root.js";
import { createOutput, type Output } from "../output.js";
import { repoRoot } from "../git.js";
import { lookAtAddress, looksLikeMapAddress, parseReadAt, selectReadMap, threadPostIdAddress } from "../local/address-read.js";
import { lookAtCommit } from "../local/map-look.js";
import { readCheckoutAt } from "../local/map-resolve.js";
import { entriesAsOf, folderKeeping, folderState, renderFolderState, sinceCursorFile, type FolderState } from "../local/folder-state.js";
import { parseTimeCursor } from "../local/threads.js";
import type { CommandDef } from "../types.js";
import { allowedFlags } from "../agent-tools/flags.js";

const DEPTHS = "<name|summary|surface|children|full>";
const USAGE =
  `ideaspaces look [<path>] [--depth ${DEPTHS}] [--contract <foundation|agreement>] [--agreement <summary|full>] [--limit <n>] [--since <child|id|date>] [--order older|newer] [--post msg_…] [--as-of <date|id|file>] [--pin <sha>] [--json]\n` +
  `       ideaspaces look <@root//position | //position> [--map <note.md>] [--at <pin|head>] [--depth ${DEPTHS}] [--agreement <summary|full>] [--limit <n>] [--since <child>] [--order older|newer] [--post msg_…] [--json]`;

interface PortableProjection {
  root: LocalProjectionRoot;
  portable: boolean;
  dirty: boolean | null;
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
  description: "Read one local Note, Content directory or Thread folder at a progressive-disclosure rung",
  usage: USAGE,
  examples: [
    "ideaspaces look notes/decision.md",
    "ideaspaces look @notes//ideas --map space.map.md --depth children",
    "ideaspaces look @n_0123456789abcdef01234567//gaps/plan.md --at pin   # against the launch Map",
    "ideaspaces look notes/decision.md --pin 0123456789abcdef0123456789abcdef01234567",
    "ideaspaces look notes/decision.md --depth children",
    "ideaspaces look research --depth full --json",
    "ideaspaces look _threads/decision --limit 50 --order newer  # paging implies --depth children; each post shows its id; continue with --since <nextCursor>",
    "ideaspaces look _threads/decision --post msg_75cc2f37  # reads that post at --depth full; unique id, not guessed",
    "ideaspaces look _threads/decision  # a folder that keeps time starts with its state: name, parent, about, closed, current Map, from its entries",
    "ideaspaces look _threads/decision --as-of 2026-11-01  # the state and the entries as they stood at the end of that day",
    "ideaspaces look _threads/decision --since msg_75cc2f37  # the entries after that one; a date works too",
    "ideaspaces look memory --depth children  # any folder whose Agreement says keeps_time: true reads the same way; files without an id are Notes",
    "ideaspaces look --post msg_75cc2f37 --depth summary  # searches only the current Space root (cwd)",
    "ideaspaces look @home//_threads/decision/msg_75cc2f37 --map thread.map.md --at pin --depth full",
    "ideaspaces look . --contract foundation --depth summary",
    "ideaspaces look _threads/decision/2026-10-02T10-00-00Z-direction.md --agreement full  # the Thread's own Agreement in full; ancestors stay summary",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);
    if ((args.length !== 1 || !args[0]?.trim()) && !(args.length === 0 && typeof flags.post === "string" && flags.post.trim())) {
      output.error(`Usage: ${USAGE}`);
      return 1;
    }

    const raw = args[0]?.trim() ?? ".";
    if (flags.new !== undefined) {
      output.error("--new is a cursor action, not a look rung; use ideaspaces threads open --new.");
      return 1;
    }
    const allowed = allowedFlags("look");
    const unknown = Object.keys(flags).find((flag) => !allowed.has(flag));
    if (unknown) {
      output.error(`Unknown flag for look: --${unknown}`);
      return 1;
    }
    let since = typeof flags.since === "string" && flags.since.trim() ? flags.since.trim() : undefined;
    const postId = typeof flags.post === "string" && flags.post.trim() ? flags.post.trim() : undefined;
    if (flags.since !== undefined && !since) {
      output.error("--since needs the nextCursor value from the previous directory page, or in a folder that keeps time an entry id or an ISO date.");
      return 1;
    }
    const asOfRaw = typeof flags["as-of"] === "string" && flags["as-of"].trim() ? flags["as-of"].trim() : undefined;
    if (flags["as-of"] !== undefined && !asOfRaw) {
      output.error("--as-of needs a moment (an ISO date or instant), an entry id, or an entry's filename.");
      return 1;
    }
    if (asOfRaw && (flags.pin !== undefined || flags.map !== undefined || flags.at !== undefined || postId)) {
      output.error("--as-of reads a local folder that keeps time as it stood at a moment; it does not combine with --pin, --map, --at or --post (a commit is --pin; one entry is --post).");
      return 1;
    }
    if (flags.post !== undefined && !postId) {
      output.error("--post needs a msg_ post id.");
      return 1;
    }
    const order: "older" | "newer" | null | undefined = flags.order === undefined ? undefined
      : flags.order === "older" || flags.order === "newer" ? flags.order : null;
    if (order === null) {
      output.error("--order must be older or newer.");
      return 1;
    }
    if (postId && (flags.limit !== undefined || since || order)) {
      output.error("--post selects one id; omit limit, since and order, which page a directory."); return 1;
    }
    if (isRemoteAddress(raw)) {
      output.error("Remote look is not available yet; use a local path.");
      return 1;
    }
    // Without --depth, a paging flag asks for a page of children and --post for that post whole.
    const depth = flags.depth === undefined && postId ? "full"
      : flags.depth === undefined && (flags.limit !== undefined || since || order) ? "children"
      : parseDepth(flags.depth);
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
    const reference = agreementFlag(flags.agreement);
    if (reference.error) {
      output.error(reference.error);
      return 1;
    }

    if (looksLikeMapAddress(raw)) {
      if (threadPostIdAddress(raw) && (limit !== undefined || since || order)) {
        output.error("A post-id address selects one post; omit limit, since and order."); return 1;
      }
      if (flags.pin !== undefined) {
        output.error("--pin reads a path in this checkout; an address takes its pin from the Map. Use --at pin.");
        return 1;
      }
      const at = parseReadAt(flags.at);
      if (at === null) {
        output.error("--at must be pin or head");
        return 1;
      }
      let note;
      try {
        note = selectReadMap(flags.map);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
      try {
        const read = await lookAtAddress(note, raw, {
          depth,
          ...(at ? { at } : {}),
          ...(selected.source ? { contractSource: selected.source } : {}),
          ...(reference.agreement ? { agreement: reference.agreement } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(since ? { since } : {}),
          ...(order ? { order } : {}),
          ...(postId ? { postId } : {}),
        });
        return emit(output, global.json, read.ok, read.data, read.text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return emit(output, global.json, false,
          { source: "map", address: raw, status: "read_error", reason },
          `Cannot read Map address ${raw}: ${reason}`);
      }
    }
    if (flags.map !== undefined || flags.at !== undefined) {
      output.error(`--map and --at read a Map address (@<root>//<position> or //<position>); ${JSON.stringify(raw)} is a path.`);
      return 1;
    }
    const path = resolve(raw);
    // A folder that keeps time (a Thread, or keeps_time: true) carries a state and reads in time: --since may
    // be an entry id or a moment, resolved to the filename the protocol pages from; --as-of selects the
    // entries at or before a cursor before the state and the page are derived.
    const keeping = existsSync(path) && statSync(path).isDirectory() ? folderKeeping(path) : null;
    if (asOfRaw && !keeping) {
      output.error(`--as-of reads a folder that keeps time (a Thread, or one whose Agreement says keeps_time: true); ${raw} is not one. For a commit, use --pin <sha>.`);
      return 1;
    }
    const asOf = asOfRaw ? parseTimeCursor(asOfRaw) : undefined;
    if (since && keeping && !since.endsWith(".md")) {
      try {
        since = sinceCursorFile(path, since);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    if (flags.pin !== undefined) {
      return lookAtPin(output, global.json, raw, flags.pin, {
        depth,
        ...(selected.source ? { contractSource: selected.source } : {}),
        ...(reference.agreement ? { agreement: reference.agreement } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(since ? { since } : {}),
        ...(order ? { order } : {}),
        ...(postId ? { postId } : {}),
      });
    }

    let looked;
    try {
      const options = {
        position: path,
        depth,
        ...(selected.source ? { contractSource: selected.source } : {}),
        ...(reference.agreement ? { agreement: reference.agreement } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(since ? { since } : {}),
        ...(order ? { order } : {}),
        ...(postId ? { postId } : {}),
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
      if ("postId" in looked) {
        return emit(output, global.json, false,
          { status: looked.status, post_id: looked.postId, position: looked.position, reason: looked.reason },
          `Cannot select post ${looked.postId}: ${looked.reason}`);
      }
      output.error(renderContentLook(looked));
      return 1;
    }

    let state: FolderState | null = null;
    let stateProblem: string | undefined;
    if (keeping && looked.target.kind === "directory" && !postId) {
      try {
        state = folderState(path, asOf);
      } catch (error) {
        // The protocol's read of the folder stands on its own; a state that cannot be derived (a README
        // with no frontmatter, a stray file) is named, never a refusal of the read. --as-of needs it, though.
        stateProblem = error instanceof Error ? error.message : String(error);
        if (asOf) { output.error(`Cannot read ${raw} as of ${asOfRaw}: ${stateProblem}`); return 1; }
      }
      try {
        if (asOf && looked.target.children) {
          // The page as of the cursor: entries after it are left out; folders and Notes (no entry handle) stay.
          const kept = entriesAsOf(path, asOf);
          const children = looked.target.children.filter((child) => child.kind !== "markdown" || !("post" in child && child.post) || kept.has(child.position.split("/").pop() ?? child.position));
          const left = looked.target.children.length - children.length;
          looked = { ...looked, target: { ...looked.target, children, ...(looked.target.page ? { page: { ...looked.target.page, shown: children.length, total: Math.max(0, looked.target.page.total - left) } } : {}) } };
        }
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    let projection: PortableProjection;
    try {
      projection = await projectPortableMap(looked, { page: { ...(since ? { since } : {}), ...(order ? { order } : {}) } });
    } catch (error) {
      // Portability is stricter than local readability. If Git or identity
      // verification races or fails, retain the useful read and omit the Map.
      projection = {
        root: {
          local_path: looked.reference.position.repoRoot ?? looked.reference.spaceRoot,
          sha: null,
        },
        portable: false,
        dirty: null,
        localOnlyPaths: [],
        issue: `Could not verify a portable Map root: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const text = state ? `${renderFolderState(state)}\n\n${renderContentLook(looked)}`
      : stateProblem ? `State of ${raw}: not derived (${stateProblem})\n\n${renderContentLook(looked)}` : renderContentLook(looked);
    const data = {
      text,
      kind: looked.kind,
      source: "local-working-tree",
      depth,
      ...(state ? { state } : {}),
      ...(stateProblem ? { state_problem: stateProblem } : {}),
      ...(asOfRaw ? { as_of: asOfRaw } : {}),
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

/** A failed read still gives --json callers its structured status on stdout, and exits 1. */
function emit(output: Output, json: boolean, ok: boolean, data: Record<string, unknown>, text: string): number {
  if (ok || json) output.result({ ...data, ok }, text);
  if (ok) return 0;
  output.error(text);
  return 1;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A path in the caller's own checkout, read at an authored commit — never HEAD, never the working tree. */
async function lookAtPin(
  output: Output,
  json: boolean,
  raw: string,
  pin: string | boolean,
  options: Parameters<typeof lookAtCommit>[1],
): Promise<number> {
  if (typeof pin !== "string" || !FULL_SHA.test(pin)) {
    output.error("--pin must be a full commit id (40 or 64 hex characters).");
    return 1;
  }
  const path = resolve(raw);
  let checkout: string;
  try {
    // The path may be gone from the working tree and still be in the commit.
    let probe = path;
    while (!existsSync(probe) || !statSync(probe).isDirectory()) probe = dirname(probe);
    checkout = repoRoot(probe);
  } catch {
    output.error(`${path} is not inside a Git checkout; a pinned read needs one.`);
    return 1;
  }
  const local = relative(checkout, path);
  if (local === ".." || local.startsWith(`..${sep}`)) {
    output.error(`${path} is outside the checkout at ${checkout}.`);
    return 1;
  }
  const position = local.split(sep).join("/") || ".";
  const found = readCheckoutAt(checkout, pin, position, 1);
  const kind = found.status === "read" ? found.kind : found.status === "too_large" ? "file" : undefined;
  const header = `Pinned read: ${position}\n  checkout: ${checkout}\n  at: pin ${pin}`;
  if (!kind) {
    output.error(`${header}\n  status: ${found.status} — ${"reason" in found ? found.reason : ""}`);
    return 1;
  }
  const base = { source: "pin", checkout, position, at: "pin", commit: pin, kind };
  let looked: Awaited<ReturnType<typeof lookAtCommit>>;
  try {
    looked = await lookAtCommit(
      { checkoutPath: checkout, commit: pin, position, kind, label: { root: checkout, prefix: `${checkout}${sep}` } },
      options,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return emit(output, json, false, { ...base, status: "read_error", reason }, `${header}\n  status: read_error — ${reason}`);
  }
  if (looked.status === "ok") {
    const { reference, target } = looked.result;
    return emit(output, json, true, { ...base, text: looked.text, reference, target }, `${header}\n\n${looked.text}`);
  }
  const reason = "reason" in looked ? looked.reason : looked.text;
  return emit(output, json, false, { ...base, status: looked.status, reason }, `${header}\n  status: ${looked.status} — ${reason}`);
}

export interface PortableProjectionDependencies {
  readGitState?: (repoRoot: string) => Promise<GitState>;
  reread?: typeof assembleContentLook;
  /** Recheck the same directory page, not the default first page. */
  page?: { since?: string; order?: "older" | "newer" };
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
    ...(looked.target.page
      ? { limit: looked.target.page.shown,
          ...(dependencies.page?.since ? { since: dependencies.page.since } : {}),
          ...(dependencies.page?.order ? { order: dependencies.page.order } : {}) }
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
    // git check-ignore evaluates nonexistent paths too. Add the possible
    // surface only when it exists, or an unrelated README ignore rule would
    // suppress an otherwise portable directory projection.
    if (existsSync(join(target.path, "README.md"))) {
      paths.push(target.position === "." ? "README.md" : `${target.position}/README.md`);
    }
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
