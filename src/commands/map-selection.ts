import {
  buildMap,
  gitState,
  inspectFrontmatterSyntax,
  parseFrontmatter,
  resolveRepoRoot,
  type MapDepth,
} from "@ideaspaces/protocol";
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";

import { fetchContentTree, fetchEntity, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { resolveSpaceBinding, type BindingFailure } from "../auth/resolve-space.js";
import {
  originUrl,
  pathStatus,
  sanitizedGitEnvironment,
} from "../git.js";
import { formatPortableMap, parseExchangeMapSelection } from "../exchange-map-selection.js";
import { canonicalRepoUrl, rootNodeIdFromGitUrl } from "../repo-locator.js";
import type { Output } from "../output.js";
import type { GlobalFlags } from "../types.js";

const NOTE_DEPTHS = new Set<MapDepth>(["name", "summary", "surface", "children", "full"]);
const HOSTNAME = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]+)?$/;

export const MAP_SELECT_USAGE =
  "ideaspaces map select <note.md> --hostname <domain> [--note-depth <name|summary|surface|children|full>] [--entity-depth <name|summary>] [--note-name <label>] [--note-summary <context>] [--entity-name <label>] [--entity-summary <context>] [--json]";

type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bindingFailure(failure: BindingFailure): string {
  switch (failure) {
    case "unpublished":
    case "local-only":
      return "This Space is local or unpublished. Publish it before selecting exact Inbox context.";
    case "identity-dirty":
      return "The root identity declaration differs from HEAD. Commit or restore it before selecting context.";
    case "identity-drift":
    case "identity-ambiguous":
      return "The checkout identity and canonical origin disagree. Repair the Space binding before selecting context.";
    case "identity-entrypoint-conflict":
      return "Agreement and Foundation declare different root identities. Align them before selecting context.";
    case "identity-invalid":
      return "Space identity evidence is invalid. Inspect the selected Agreement or Foundation before selecting context.";
    case "unreachable":
      return "Could not reach the account needed to resolve this hosted Space. Retry when online.";
    case "ambiguous":
      return "The checkout matches more than one hosted Space. Repair its local binding before selecting context.";
    case "no-match":
      return "Could not bind this checkout to a hosted Space. Run `ideaspaces link .` or publish it first.";
  }
}

function gitRead(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: sanitizedGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message || result.stderr.trim() || `git ${args.join(" ")} failed`,
    );
  }
  return result.stdout;
}

function exactRemoteHead(cwd: string, branch: string): string {
  const output = gitRead(cwd, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error(`origin has no exact refs/heads/${branch} branch`);
  const [sha, ref, ...extra] = lines[0]!.trim().split(/\s+/);
  if (!sha || ref !== `refs/heads/${branch}` || extra.length) {
    throw new Error(`origin returned an ambiguous refs/heads/${branch} coordinate`);
  }
  return sha;
}

function relativePosition(repoRoot: string, notePath: string): string {
  const path = relative(repoRoot, notePath).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error("The selected Note must be inside its repository root");
  }
  return path;
}

function noteDisclosure(content: string, position: string): { name: string; summary: string } {
  const syntax = inspectFrontmatterSyntax(content);
  if (syntax.status === "malformed") {
    throw new Error(`The committed Note has malformed frontmatter: ${syntax.message}`);
  }
  const frontmatter = parseFrontmatter(content) ?? {};
  const rawName = frontmatter.name;
  const rawSummary = frontmatter.summary;
  if (rawName !== undefined && typeof rawName !== "string") {
    throw new Error("The committed Note frontmatter name must be a string");
  }
  if (rawSummary !== undefined && typeof rawSummary !== "string") {
    throw new Error("The committed Note frontmatter summary must be a string");
  }
  return {
    name: rawName || basename(position, posix.extname(position)),
    summary: rawSummary || "",
  };
}

function annotation(flags: Flags, prefix: "note" | "entity"): { name?: string; summary?: string } {
  return {
    ...(flagString(flags, `${prefix}-name`) ? { name: flagString(flags, `${prefix}-name`)! } : {}),
    ...(flagString(flags, `${prefix}-summary`)
      ? { summary: flagString(flags, `${prefix}-summary`)! }
      : {}),
  };
}

function noteDepth(flags: Flags): MapDepth | null {
  const value = flagString(flags, "note-depth") ?? "surface";
  return NOTE_DEPTHS.has(value as MapDepth) ? value as MapDepth : null;
}

function entityDepth(flags: Flags): "name" | "summary" | null {
  const value = flagString(flags, "entity-depth") ?? "summary";
  return value === "name" || value === "summary" ? value : null;
}

function canonicalHostname(flags: Flags): string | null {
  const raw = flagString(flags, "hostname");
  if (!raw) return null;
  const value = raw.toLowerCase();
  return HOSTNAME.test(value) ? value : null;
}

export async function runMapSelection(
  args: string[],
  flags: Flags,
  _global: GlobalFlags,
  output: Output,
): Promise<number> {
  const rawNote = args[0];
  const selectedNoteDepth = noteDepth(flags);
  const selectedEntityDepth = entityDepth(flags);
  const hostname = canonicalHostname(flags);
  if (!rawNote || args.length !== 1 || !hostname) {
    output.error(`Usage: ${MAP_SELECT_USAGE}`);
    return 1;
  }
  if (!selectedNoteDepth) {
    output.error("--note-depth must be name, summary, surface, children, or full");
    return 1;
  }
  if (!selectedEntityDepth) {
    output.error("--entity-depth must be name or summary");
    return 1;
  }
  const config = loadConfig();
  if (!config) {
    output.error("Not logged in. Run `ideaspaces login`.");
    return 1;
  }

  try {
    const absoluteNote = realpathSync.native(resolve(rawNote));
    if (!statSync(absoluteNote).isFile()) throw new Error("The selected Note is not a file");
    const resolvedRoot = await resolveRepoRoot(dirname(absoluteNote));
    if (!resolvedRoot) throw new Error("The selected Note is not inside a Git repository");
    const repoRoot = realpathSync.native(resolvedRoot);
    const position = relativePosition(repoRoot, absoluteNote);
    if (!position.toLowerCase().endsWith(".md")) {
      throw new Error("The selected context must be a Markdown Note");
    }

    const selectedStatus = pathStatus(position, repoRoot);
    if (!selectedStatus.inTracked) {
      throw new Error("The selected Note is local-only. Commit and push it before sharing exact context.");
    }
    if (selectedStatus.modified || selectedStatus.inIndex) {
      throw new Error("The selected Note differs from HEAD. Commit or restore it before sharing exact context.");
    }

    const [state, binding] = await Promise.all([
      gitState(repoRoot),
      resolveSpaceBinding(repoRoot, config),
    ]);
    if (!state.headSha || !state.branch) {
      throw new Error("The selected Note needs a committed branch before it can be shared");
    }
    if (!("rootNodeId" in binding)) throw new Error(bindingFailure(binding.failure));

    const remoteHead = exactRemoteHead(repoRoot, state.branch);
    if (remoteHead !== state.headSha) {
      throw new Error(
        `The selected Note's HEAD is not published at origin/${state.branch}. Push it without rewriting the selection, then retry.`,
      );
    }
    const remote = originUrl(repoRoot);
    const originRootNodeId = remote ? rootNodeIdFromGitUrl(remote, config.apiUrl) : null;
    if (!originRootNodeId) {
      throw new Error("The selected checkout has no portable origin. Publish it before sharing exact context.");
    }
    if (originRootNodeId !== binding.rootNodeId) {
      throw new Error("The origin is not the canonical hosted repository for this root identity");
    }
    const repo = canonicalRepoUrl(config.apiUrl, binding.rootNodeId);

    const parent = posix.dirname(position) === "." ? "" : posix.dirname(position);
    const [tree, entity] = await Promise.all([
      fetchContentTree(config, binding.rootNodeId, parent),
      fetchEntity(config, "hostname", hostname),
    ]);
    if (tree.root_node_id !== binding.rootNodeId) {
      throw new Error("The hosted Content tree returned a different root identity");
    }
    if (!tree.hosted_history_available) {
      throw new Error("Hosted history is not available for this Space. Share history before selecting an exact Note.");
    }
    const matches = tree.children.filter(
      (child) => child.path === position && child.type === "file" && child.node_type === "note" && child.node_id,
    );
    if (matches.length !== 1) {
      throw new Error("The selected Note is absent or ambiguous in the hosted index. Push and wait for indexing, then retry.");
    }
    if (entity.entity_type !== "hostname" || entity.entity_key !== hostname) {
      throw new Error("The hosted entity response does not match the selected hostname");
    }

    const committed = gitRead(repoRoot, ["show", `${state.headSha}:${position}`]);
    const observedNote = noteDisclosure(committed, position);
    const noteObserved = selectedNoteDepth === "name"
      ? { name: observedNote.name }
      : observedNote;
    const entityObserved = selectedEntityDepth === "name"
      ? { name: entity.name }
      : { name: entity.name, summary: entity.summary };
    const built = buildMap({
      roots: [{
        repo,
        root_node_id: binding.rootNodeId,
        sha: state.headSha,
      }],
      members: [
        {
          root: 0,
          position,
          depth: selectedNoteDepth,
          ...annotation(flags, "note"),
          disclosure: noteObserved,
        },
        {
          address: `hostname:${hostname}`,
          depth: selectedEntityDepth,
          ...annotation(flags, "entity"),
          disclosure: entityObserved,
        },
      ],
    });
    if (built.status === "invalid") {
      const detail = built.issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
      throw new Error(`Could not build the portable selection: ${detail}`);
    }
    const selection = parseExchangeMapSelection({
      kind: "exchange-map-selection",
      target_node_id: matches[0]!.node_id,
      map: built.map,
    });
    output.result(
      selection,
      [
        `Portable Inbox context — about ${selection.target_node_id}`,
        ...formatPortableMap(selection.map),
        "Review this selection, then send it with `ideaspaces inbox send … --map <selection.json>`.",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    output.error(
      error instanceof UnauthorizedError
        ? "Session expired. Run `ideaspaces login`."
        : error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}
