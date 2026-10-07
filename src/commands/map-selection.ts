import {
  buildMap,
  classifyRepositoryPath,
  gitState,
  inspectFrontmatterSyntax,
  parseFrontmatter,
  parseMap,
  resolveRepoRoot,
  type MapDepth,
  type MapMember,
  type MapRoot,
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
import { inspectSpaceMapRoots } from "../local/space-map.js";
import { canonicalRepoUrl, rootNodeIdFromGitUrl } from "../repo-locator.js";
import type { Output } from "../output.js";
import type { GlobalFlags } from "../types.js";

const NOTE_DEPTHS = new Set<MapDepth>(["name", "summary", "surface", "children", "full"]);
const HOSTNAME = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]+)?$/;
/** Index-fresh Content-tree reads can exceed the 5s default. Only these GETs
 * get a longer window; request() retains its one idempotent timeout retry. */
export const MAP_TREE_READ_TIMEOUT_MS = 15_000;

export const MAP_SELECT_USAGE =
  "ideaspaces map select <note.md|map.map.md|dir> [--hostname <domain>] [--note-depth <name|summary|surface|children|full>] [--entity-depth <name|summary>] [--note-name <label>] [--note-summary <context>] [--entity-name <label>] [--entity-summary <context>] [--about <node_id>] [--json]";

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

function relativePosition(repoRoot: string, targetPath: string): string {
  const path = relative(repoRoot, targetPath).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error("The selected target must be inside its repository root");
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

function noteDepth(flags: Flags, defaultDepth: MapDepth = "surface"): MapDepth | null {
  const value = flagString(flags, "note-depth") ?? defaultDepth;
  return NOTE_DEPTHS.has(value as MapDepth) ? (value as MapDepth) : null;
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
  const rawTarget = args[0];
  if (!rawTarget || args.length !== 1) {
    output.error(`Usage: ${MAP_SELECT_USAGE}`);
    return 1;
  }
  if (flags.hostname !== undefined && !canonicalHostname(flags)) {
    output.error("Invalid --hostname: must be a canonical hostname.");
    return 1;
  }
  const selectedEntityDepth = entityDepth(flags);
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
    const absoluteTarget = realpathSync.native(resolve(rawTarget));
    const isDir = statSync(absoluteTarget).isDirectory();
    const isFile = statSync(absoluteTarget).isFile();
    if (!isDir && !isFile) {
      throw new Error("The selected target does not exist or is not a file or directory");
    }

    const resolvedRoot = await resolveRepoRoot(isDir ? absoluteTarget : dirname(absoluteTarget));
    if (!resolvedRoot) throw new Error("The selected target is not inside a Git repository");
    const repoRoot = realpathSync.native(resolvedRoot);

    const [state, binding] = await Promise.all([
      gitState(repoRoot),
      resolveSpaceBinding(repoRoot, config),
    ]);
    if (!state.headSha || !state.branch) {
      throw new Error("The selected target needs a committed branch before it can be shared");
    }
    const headSha: string = state.headSha;
    if (!("rootNodeId" in binding)) throw new Error(bindingFailure(binding.failure));

    const remoteHead = exactRemoteHead(repoRoot, state.branch);
    if (remoteHead !== state.headSha) {
      throw new Error(
        `The selected target's HEAD is not published at origin/${state.branch}. Push it without rewriting the selection, then retry.`,
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

    let targetNodeId = flagString(flags, "about");
    let roots: MapRoot[];
    let members: MapMember[];

    if (isDir) {
      if (repoRoot !== absoluteTarget) {
        throw new Error(`Not a repository root: ${rawTarget} (root is ${repoRoot})`);
      }
      if (state.dirty) {
        throw new Error("The selected repository differs from HEAD. Commit or restore it before sharing exact context.");
      }
      const selectedNoteDepth = noteDepth(flags, "summary");
      if (!selectedNoteDepth) {
        output.error("--note-depth must be name, summary, surface, children, or full");
        return 1;
      }
      const rawFiles = gitRead(repoRoot, ["ls-tree", "-r", "--name-only", state.headSha])
        .trim()
        .split("\n")
        .filter(Boolean);
      const markdownPaths = rawFiles.filter((p) => {
        const c = classifyRepositoryPath(p, "file");
        return c.status === "ok" && (c.role === "knowledge" || c.role === "agent-context");
      });
      const positionMembers: MapMember[] = [];
      for (const pos of markdownPaths) {
        const committed = gitRead(repoRoot, ["show", `${state.headSha}:${pos}`]);
        const obs = noteDisclosure(committed, pos);
        const disclosure = selectedNoteDepth === "name" ? { name: obs.name } : obs;
        positionMembers.push({
          root: 0,
          position: pos,
          depth: selectedNoteDepth,
          disclosure,
        });
      }
      roots = [{
        repo,
        root_node_id: binding.rootNodeId,
        sha: headSha,
      }];
      members = positionMembers;

      if (!targetNodeId) {
        const hostedTree = await fetchContentTree(config, binding.rootNodeId, "", { timeoutMs: MAP_TREE_READ_TIMEOUT_MS });
        if (hostedTree.root_node_id !== binding.rootNodeId) {
          throw new Error("The hosted Content tree returned a different root identity");
        }
        if (!hostedTree.hosted_history_available) {
          throw new Error("Hosted history is not available for this Space. Share history before selecting context.");
        }
        // Look for entry note
        const candidates = ["_agent/agreement.md", "_agent/foundation.md", "README.md"];
        const match = hostedTree.children.find(
          (child) => candidates.includes(child.path) && child.type === "file" && child.node_type === "note" && child.node_id,
        ) ?? hostedTree.children.find(
          (child) => child.type === "file" && child.node_type === "note" && child.node_id,
        );
        if (!match?.node_id) {
          throw new Error("The repository has no indexed entry Note. Pass --about <node_id>.");
        }
        targetNodeId = match.node_id ?? undefined;
      }
    } else {
      const position = relativePosition(repoRoot, absoluteTarget);
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

      const committed = gitRead(repoRoot, ["show", `${state.headSha}:${position}`]);
      const syntax = inspectFrontmatterSyntax(committed);
      if (syntax.status === "malformed") {
        throw new Error(`The committed Note has malformed frontmatter: ${syntax.message}`);
      }
      const frontmatter = parseFrontmatter(committed) ?? {};
      const isMapNote = basename(position).endsWith(".map.md") || (basename(position) === "README.md" && frontmatter.map !== undefined);

      if (isMapNote && frontmatter.map && typeof frontmatter.map === "object") {
        const parsedMap = parseMap(frontmatter.map);
        if (parsedMap.status !== "valid") throw new Error("The selected Map Note has an invalid Map block; repair it before sending.");
        const rawRoots = parsedMap.map.roots;
        const rawMembers = parsedMap.map.members;

        roots = rawRoots.map((r) => {
          if (!r || typeof r !== "object") throw new Error("Map root must be an object");
          const rObj = r as Record<string, unknown>;
          const rNodeId = typeof rObj.root_node_id === "string" ? rObj.root_node_id : binding.rootNodeId;
          const rSha = typeof rObj.sha === "string" ? rObj.sha : undefined;
          const rRepo = typeof rObj.repo === "string" ? rObj.repo : canonicalRepoUrl(config.apiUrl, rNodeId);
          return { repo: rRepo, root_node_id: rNodeId, ...(rSha ? { sha: rSha } : {}) };
        });
        if (roots.length === 0) {
          roots = [{ repo, root_node_id: binding.rootNodeId, sha: headSha }];
        }

        // A Space Map names live roots. A sent Map is a moment: pin every
        // unpinned root at its OWN locally identified checkout's HEAD now.
        const located = inspectSpaceMapRoots(roots, repoRoot);
        roots = roots.map((root, index) => {
          if (root.sha) return root;
          const head = located[index]?.headSha;
          if (!head) throw new Error(`Map root ${index} (${root.root_node_id ?? root.repo ?? "unnamed"}) has no reachable local HEAD to pin for sending.`);
          return { ...root, sha: head };
        });

        members = rawMembers.map((m) => {
          if (!m || typeof m !== "object") throw new Error("Map member must be an object");
          const mObj = m as Record<string, unknown>;
          if ("address" in mObj && typeof mObj.address === "string") {
            const disc = mObj.disclosure && typeof mObj.disclosure === "object"
              ? (mObj.disclosure as { name?: string; summary?: string })
              : { name: typeof mObj.name === "string" ? mObj.name : mObj.address, summary: typeof mObj.summary === "string" ? mObj.summary : "" };
            return {
              address: mObj.address,
              ...(mObj.depth ? { depth: mObj.depth as "name" | "summary" } : {}),
              ...(mObj.name ? { name: String(mObj.name) } : {}),
              ...(mObj.summary ? { summary: String(mObj.summary) } : {}),
              disclosure: { name: disc.name || mObj.address, ...(disc.summary !== undefined ? { summary: disc.summary } : {}) },
            };
          }
          const mPos = typeof mObj.position === "string" ? mObj.position : "";
          const mRoot = typeof mObj.root === "number" ? mObj.root : 0;
          const mDepth = (typeof mObj.depth === "string" && NOTE_DEPTHS.has(mObj.depth as MapDepth) ? mObj.depth : "summary") as MapDepth;
          let disc = mObj.disclosure && typeof mObj.disclosure === "object"
            ? (mObj.disclosure as { name?: string; summary?: string })
            : undefined;
          if (!disc) {
            try {
              const rootSha = roots[mRoot]?.sha ?? headSha;
              const content = gitRead(repoRoot, ["show", `${rootSha}:${mPos}`]);
              disc = noteDisclosure(content, mPos);
            } catch {
              disc = {
                name: typeof mObj.name === "string" ? mObj.name : basename(mPos, posix.extname(mPos)),
                summary: typeof mObj.summary === "string" ? mObj.summary : "",
              };
            }
          }
          return {
            root: mRoot,
            position: mPos,
            depth: mDepth,
            ...(mObj.name ? { name: String(mObj.name) } : {}),
            ...(mObj.summary ? { summary: String(mObj.summary) } : {}),
            disclosure: { name: disc.name || basename(mPos, posix.extname(mPos)), ...(mDepth === "name" ? {} : { summary: disc.summary || "" }) },
          };
        });

        if (!targetNodeId) {
          const parent = posix.dirname(position) === "." ? "" : posix.dirname(position);
          const tree = await fetchContentTree(config, binding.rootNodeId, parent, { timeoutMs: MAP_TREE_READ_TIMEOUT_MS });
          if (tree.root_node_id !== binding.rootNodeId) {
            throw new Error("The hosted Content tree returned a different root identity");
          }
          const matches = tree.children.filter(
            (child) => child.path === position && child.type === "file" && child.node_type === "note" && child.node_id,
          );
          if (matches.length === 1 && matches[0]!.node_id) {
            targetNodeId = matches[0]!.node_id;
          } else {
            throw new Error("The selected Map Note is absent or ambiguous in the hosted index. Pass --about <node_id>.");
          }
        }
      } else {
        // Single Note selection
        const selectedNoteDepth = noteDepth(flags, "surface");
        if (!selectedNoteDepth) {
          output.error("--note-depth must be name, summary, surface, children, or full");
          return 1;
        }
        const hostname = canonicalHostname(flags);
        const parent = posix.dirname(position) === "." ? "" : posix.dirname(position);
        const [tree, entity] = await Promise.all([
          fetchContentTree(config, binding.rootNodeId, parent, { timeoutMs: MAP_TREE_READ_TIMEOUT_MS }),
          hostname ? fetchEntity(config, "hostname", hostname) : Promise.resolve(null),
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
        if (entity && (entity.entity_type !== "hostname" || entity.entity_key !== hostname)) {
          throw new Error("The hosted entity response does not match the selected hostname");
        }

        if (!targetNodeId) {
          targetNodeId = matches[0]!.node_id ?? undefined;
        }

        const observedNote = noteDisclosure(committed, position);
        const noteObserved = selectedNoteDepth === "name"
          ? { name: observedNote.name }
          : observedNote;

        roots = [{
          repo,
          root_node_id: binding.rootNodeId,
          sha: headSha,
        }];
        members = [
          {
            root: 0,
            position,
            depth: selectedNoteDepth,
            ...annotation(flags, "note"),
            disclosure: noteObserved,
          },
        ];
        if (hostname && entity) {
          const entityObserved = selectedEntityDepth === "name"
            ? { name: entity.name }
            : { name: entity.name, summary: entity.summary };
          members.push({
            address: `hostname:${hostname}`,
            depth: selectedEntityDepth,
            ...annotation(flags, "entity"),
            disclosure: entityObserved,
          });
        }
      }
    }

    if (!targetNodeId) {
      throw new Error("Could not determine target Node identity. Pass --about <node_id>.");
    }

    const built = buildMap({ roots, members });
    if (built.status === "invalid") {
      const detail = built.issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
      throw new Error(`Could not build the portable selection: ${detail}`);
    }
    const selection = parseExchangeMapSelection({
      kind: "exchange-map-selection",
      target_node_id: targetNodeId,
      map: built.map,
    });
    output.result(
      selection,
      [
        `Portable Inbox context — about ${selection.target_node_id}`,
        ...formatPortableMap(selection.map),
        "Review this selection, then send it with `ideaspaces threads send … --map <selection.json>`.",
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
