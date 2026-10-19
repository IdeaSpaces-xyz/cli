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

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  MAP_DEPTHS,
  assembleContentFocus,
  assembleContentLook,
  buildMap,
  gitState,
  inspectMarkdown,
  parseFrontmatter,
  renderContentLook,
  stripFrontmatter,
  summarizeMarkdown,
  type ContentLookManifest,
  type ContentLookResult,
  type ContentLookTarget,
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
import { createOutput, type Output } from "../output.js";
import { threadsCommand } from "./threads.js";
import { repoRoot } from "../git.js";
import { lookAtAddress, looksLikeMapAddress, parseReadAt, selectReadMap } from "../local/address-read.js";
import { lookAtCommit } from "../local/map-look.js";
import { readCheckoutAt } from "../local/map-resolve.js";
import type { CommandDef } from "../types.js";

const DEPTHS = "<name|summary|surface|children|full>";
const USAGE =
  `ideaspaces look <path> [--depth ${DEPTHS}] [--contract <foundation|agreement>] [--limit <n>] [--order <newer|older>] [--pin <sha>] [--json]\n` +
  `       ideaspaces look <@root//position | //position> [--map <note.md>] [--at <pin|head>] [--depth ${DEPTHS}] [--limit <n>] [--order <newer|older>] [--since <ISO date|post id>] [--post <id>] [--json]\n` +
  `       ideaspaces look _threads/<slug> [--depth ${DEPTHS}] [--new|--since <ISO date|post id>] [--post <id>] [--limit <n>] [--order <newer|older>] [--json]`;

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

export function buildFrameMarkdownTarget(path: string, position: string, content: string, depth: MapDepth): ContentLookTarget {
  const fm = parseFrontmatter(content);
  const name = (typeof fm?.name === "string" && fm.name.trim()) || basename(path, ".md");
  const summary = (typeof fm?.summary === "string" && fm.summary.trim()) || summarizeMarkdown(content);
  const disclosure = { name, ...(summary && depth !== "name" ? { summary } : {}) };
  const target: ContentLookTarget = {
    placement: "history",
    path,
    position,
    kind: "markdown",
    depth,
    revision: "",
    name,
    member: { position, depth, disclosure },
  };
  if (depth !== "name") {
    target.summary = summary;
  }
  if (depth === "surface" || depth === "full") {
    target.surface = stripFrontmatter(content);
  } else if (depth === "children") {
    const outline = inspectMarkdown(content, { mode: "outline" });
    target.children = outline.mode === "outline"
      ? outline.headings.map((h) => ({ ...h, kind: "section" as const, name: h.text }))
      : [];
  }
  const represented = {
    kind: target.kind,
    name: target.name,
    ...(target.summary !== undefined ? { summary: target.summary } : {}),
    ...(target.surface !== undefined ? { surface: target.surface } : {}),
    ...(target.children !== undefined ? { children: target.children } : {}),
  };
  target.revision = `sha256:${createHash("sha256").update(JSON.stringify(represented)).digest("hex")}`;
  return target;
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
    "ideaspaces look _threads/decision --depth summary --new",
    "ideaspaces look _threads/decision --depth surface --post msg_01234567-89ab-4cde-8f01-23456789abcd",
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

    if (looksLikeMapAddress(raw)) {
      if (flags.pin !== undefined) {
        output.error("--pin reads a path in this checkout; an address takes its pin from the Map. Use --at pin.");
        return 1;
      }
      const at = parseReadAt(flags.at);
      if (at === null) {
        output.error("--at must be pin or head");
        return 1;
      }
      if (flags.order !== undefined && flags.order !== "newer" && flags.order !== "older") {
        output.error("--order must be newer or older");
        return 1;
      }
      if (flags.since !== undefined && flags.order === "newer") {
        output.error("--since advances forward in time; use --order older to continue a page, or omit --since for the newest page.");
        return 1;
      }
      let note;
      try {
        note = selectReadMap(flags.map);
      } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
      const read = await lookAtAddress(note, raw, {
        depth,
        ...(at ? { at } : {}),
        ...(selected.source ? { contractSource: selected.source } : {}),
        ...(limit !== undefined ? { maxChildren: limit, limit } : {}),
        ...("order" in flags && typeof flags.order === "string" ? { order: flags.order as "newer" | "older" } : {}),
        ...("since" in flags && typeof flags.since === "string" ? { since: flags.since } : {}),
        ...("post" in flags && typeof flags.post === "string" ? { post: flags.post } : {}),
      });
      return emit(output, global.json, read.ok, read.data, read.text);
    }
    if (flags.map !== undefined || flags.at !== undefined) {
      output.error(`--map and --at read a Map address (@<root>//<position> or //<position>); ${JSON.stringify(raw)} is a path.`);
      return 1;
    }
    const path = resolve(raw);
    // Thread folders are extension payload, not Content. Route the five rungs
    // through the same bounded Thread reader as `threads open`; never reinterpret
    // their posts as ordinary Notes or substitute a pin from working-tree HEAD.
    if (/(?:^|[\\/])_threads[\\/][^\\/]+$/.test(path) && existsSync(path) && statSync(path).isDirectory()) {
      if (flags.contract !== undefined || flags.pin !== undefined) {
        output.error("A Thread folder has its own Agreement and post rungs; omit --contract and --pin. Use threads open with an authored pin for a post.");
        return 1;
      }
      const allowed = new Set(["depth", "new", "since", "post", "limit", "order"]);
      const extra = Object.keys(flags).find((flag) => !allowed.has(flag));
      if (extra) { output.error(`Unknown flag for a Thread folder: --${extra}`); return 1; }
      return threadsCommand.run(["open", path], {
        depth,
        ...("new" in flags ? { new: flags.new } : {}),
        ...("since" in flags ? { since: flags.since } : {}),
        ...("post" in flags ? { post: flags.post } : {}),
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
        ...("order" in flags ? { order: flags.order } : {}),
      }, global);
    }

    let looked: ContentLookResult | null = null;

    // Thread subpaths: posts or frame files (README.md, _agent/agreement.md)
    const threadSubMatch = /^(.*[\\/]_threads[\\/][^\\/]+)[\\/](.+)$/.exec(path);
    if (threadSubMatch && existsSync(threadSubMatch[1]) && statSync(threadSubMatch[1]).isDirectory()) {
      const threadFolder = threadSubMatch[1];
      const subEntry = threadSubMatch[2].split(sep).join("/");
      if (subEntry === "README.md" || subEntry === "_agent/agreement.md") {
        if (!existsSync(path)) {
          output.error(`No such path: ${path}`);
          return 1;
        }
        const root = await repoRoot(dirname(threadFolder)) ?? dirname(dirname(threadFolder));
        const relPos = relative(root, path).split(sep).join("/");
        const content = readFileSync(path, "utf8");
        const target = buildFrameMarkdownTarget(path, relPos, content, depth);
        let focused = await assembleContentFocus({ position: root, treeMaxEntries: 0, ...(selected.source ? { contractSource: selected.source } : {}) });
        if (focused?.status === "contract_choice_required" && !selected.source) {
          const preferred = preferredContractSource(focused.availableSources);
          if (preferred) {
            focused = await assembleContentFocus({ position: root, treeMaxEntries: 0, contractSource: preferred });
          }
        }
        if (!focused || focused.status !== "ok") {
          output.error(`Not a Content target: ${path}`);
          return 1;
        }
        looked = {
          status: "ok",
          kind: "content-look",
          contractRole: "reference",
          reference: { ...focused, tree: null },
          target,
        };
      } else if (subEntry === "_agent" && statSync(path).isDirectory()) {
        output.error("A Thread's _agent/ folder has its own Agreement; read _agent/agreement.md directly.");
        return 1;
      } else {
        // Treat as post lookup
        if (flags.contract !== undefined || flags.pin !== undefined) {
          output.error("A Thread post has its own Agreement and post rungs; omit --contract and --pin.");
          return 1;
        }
        return threadsCommand.run(["open", threadFolder], {
          depth,
          post: subEntry,
          ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
          ...("order" in flags ? { order: flags.order } : {}),
        }, global);
      }
    }
    if (flags.pin !== undefined) {
      return lookAtPin(output, global.json, raw, flags.pin, {
        depth,
        ...(selected.source ? { contractSource: selected.source } : {}),
        ...(limit !== undefined ? { maxChildren: limit } : {}),
      });
    }

    if (!looked) {
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
        dirty: null,
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
  const looked = await lookAtCommit(
    { checkoutPath: checkout, commit: pin, position, kind, label: { root: checkout, prefix: `${checkout}${sep}` } },
    options,
  );
  const base = { source: "pin", checkout, position, at: "pin", commit: pin, kind };
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
