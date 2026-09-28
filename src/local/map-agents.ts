import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  inspectFrontmatterSyntax,
  parseFrontmatter,
  type MapBlock,
  type MapRoot,
} from "@ideaspaces/protocol";
import { getDefaultApiUrl, loadConfig } from "../auth/credentials.js";
import { loadSpaces, type SpaceRecord } from "../auth/spaces.js";
import { sanitizedGitEnvironment } from "../git.js";
import type { LoadedMapNote } from "./map-note.js";
import { canonicalRepoUrl, rootNodeIdFromGitUrl } from "../repo-locator.js";
import { inspectLocalRootIdentity } from "../root-identity.js";

export interface MapAgentListing {
  name: string;
  summary?: string;
  agreement: string;
  root_node_id?: string;
  sha: string;
  path: string;
  position?: string;
}

export interface MapUnresolvedRoot {
  root_node_id?: string;
  repo?: string;
  sha: string;
  path?: string;
  reason: "unbound" | "unavailable_pin" | "git_error";
  detail?: string;
}

export interface MapAgentsResult {
  agents: MapAgentListing[];
  unresolved: MapUnresolvedRoot[];
}

export interface CheckoutResolverOptions {
  cwd?: string;
  apiUrl?: string;
  spacesMap?: Record<string, SpaceRecord>;
  localCheckouts?: Record<string, string>;
}

function resolveLocalCheckout(
  root: MapRoot,
  options?: CheckoutResolverOptions,
): string | null {
  if (options?.localCheckouts) {
    if (root.root_node_id && options.localCheckouts[root.root_node_id]) {
      const p = options.localCheckouts[root.root_node_id];
      if (existsSync(p)) return p;
    }
    if (root.repo && options.localCheckouts[root.repo]) {
      const p = options.localCheckouts[root.repo];
      if (existsSync(p)) return p;
    }
  }

  const spaces = options?.spacesMap ?? loadSpaces();
  const apiUrl = options?.apiUrl ?? loadConfig()?.apiUrl ?? getDefaultApiUrl();

  for (const [folderPath, record] of Object.entries(spaces)) {
    if (root.root_node_id && record.root_node_id === root.root_node_id) {
      if (existsSync(folderPath)) return folderPath;
    }
    if (root.repo) {
      const idFromUrl = rootNodeIdFromGitUrl(root.repo, apiUrl);
      if (idFromUrl && record.root_node_id === idFromUrl) {
        if (existsSync(folderPath)) return folderPath;
      }
      if (record.root_node_id && canonicalRepoUrl(apiUrl, record.root_node_id) === root.repo) {
        if (existsSync(folderPath)) return folderPath;
      }
      if (record.canonical_path && root.repo.endsWith(record.canonical_path)) {
        if (existsSync(folderPath)) return folderPath;
      }
    }
  }

  const cwd = options?.cwd ? resolve(options.cwd) : process.cwd();
  if (existsSync(cwd)) {
    const identity = inspectLocalRootIdentity(cwd, apiUrl);
    if (root.root_node_id && identity.root_node_id === root.root_node_id) {
      return cwd;
    }
    if (
      root.repo &&
      identity.canonical_origin &&
      canonicalRepoUrl(apiUrl, identity.canonical_origin) === root.repo
    ) {
      return cwd;
    }
  }

  return null;
}

function readGitBlobAtCommit(
  repoPath: string,
  sha: string,
  relativePath: string,
): { ok: boolean; content?: string; reason?: "unavailable_pin" | "missing_path" | "git_error"; detail?: string } {
  const commitCheck = spawnSync("git", ["-C", repoPath, "cat-file", "-e", `${sha}^{commit}`], {
    encoding: "utf-8",
    env: sanitizedGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
  });
  if (commitCheck.error) {
    return { ok: false, reason: "git_error", detail: commitCheck.error.message };
  }
  if (commitCheck.status !== 0) {
    const stderr = (commitCheck.stderr ?? "").trim();
    if (stderr.includes("fatal: not a git repository")) {
      return { ok: false, reason: "git_error", detail: stderr };
    }
    return { ok: false, reason: "unavailable_pin" };
  }

  const show = spawnSync("git", ["-C", repoPath, "show", `${sha}:${relativePath}`], {
    encoding: "utf-8",
    env: sanitizedGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
  });
  if (show.error) {
    return { ok: false, reason: "git_error", detail: show.error.message };
  }
  if (show.status !== 0) {
    const stderr = (show.stderr ?? "").trim();
    if (stderr.includes("fatal: bad object") || stderr.includes("fatal: not a git repository")) {
      return { ok: false, reason: "git_error", detail: stderr };
    }
    return { ok: false, reason: "missing_path" };
  }
  return { ok: true, content: show.stdout };
}

function isMapBlock(value: unknown): value is MapBlock {
  return typeof value === "object" && value !== null && "roots" in value && "members" in value;
}

/**
 * Project the agent-kind roots included in a Space Map selection.
 *
 * Inspects author-declared `agreement` at the exact Map pin commit in each
 * resolved local checkout without network access, folder scanning, or HEAD
 * substitution.
 */
export function projectMapAgents(
  mapInput: LoadedMapNote | MapBlock,
  options?: CheckoutResolverOptions,
): MapAgentsResult {
  const mapBlock: MapBlock = "map" in mapInput && isMapBlock(mapInput.map) ? mapInput.map : (mapInput as MapBlock);
  const roots = mapBlock.roots ?? [];
  const members = mapBlock.members ?? [];

  const spacesMap = options?.spacesMap ?? loadSpaces();
  const apiUrl = options?.apiUrl ?? loadConfig()?.apiUrl ?? getDefaultApiUrl();
  const effectiveOptions: CheckoutResolverOptions = {
    ...options,
    spacesMap,
    apiUrl,
  };

  const agents: MapAgentListing[] = [];
  const unresolved: MapUnresolvedRoot[] = [];
  const seenRootIndices = new Set<number>();

  for (const member of members) {
    if (!("root" in member) || typeof member.root !== "number") {
      continue;
    }
    const rootIndex = member.root;
    if (rootIndex < 0 || rootIndex >= roots.length) {
      continue;
    }
    if (seenRootIndices.has(rootIndex)) {
      continue;
    }
    seenRootIndices.add(rootIndex);

    const root = roots[rootIndex];
    if (!root) continue;

    const checkoutPath = resolveLocalCheckout(root, effectiveOptions);
    if (!checkoutPath) {
      unresolved.push({
        ...(root.root_node_id ? { root_node_id: root.root_node_id } : {}),
        ...(root.repo ? { repo: root.repo } : {}),
        sha: root.sha,
        reason: "unbound",
        detail: "No local checkout found",
      });
      continue;
    }

    const blobResult = readGitBlobAtCommit(checkoutPath, root.sha, "_agent/agreement.md");
    if (!blobResult.ok) {
      if (blobResult.reason === "unavailable_pin") {
        unresolved.push({
          ...(root.root_node_id ? { root_node_id: root.root_node_id } : {}),
          ...(root.repo ? { repo: root.repo } : {}),
          sha: root.sha,
          path: checkoutPath,
          reason: "unavailable_pin",
          detail: `Pin ${root.sha} not found in local checkout`,
        });
      } else if (blobResult.reason === "git_error") {
        unresolved.push({
          ...(root.root_node_id ? { root_node_id: root.root_node_id } : {}),
          ...(root.repo ? { repo: root.repo } : {}),
          sha: root.sha,
          path: checkoutPath,
          reason: "git_error",
          detail: blobResult.detail ?? "git command failed",
        });
      }
      continue;
    }

    const content = blobResult.content ?? "";
    const syntax = inspectFrontmatterSyntax(content);
    if (syntax.status !== "valid") {
      continue;
    }
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter || typeof frontmatter !== "object") {
      continue;
    }

    const declaredAgreement =
      typeof frontmatter.agreement === "string" ? frontmatter.agreement.trim() : undefined;
    if (!declaredAgreement || !declaredAgreement.startsWith("agent:repo:")) {
      continue;
    }

    const declaredName =
      typeof frontmatter.name === "string" && frontmatter.name.trim()
        ? frontmatter.name.trim()
        : undefined;
    const declaredSummary =
      typeof frontmatter.summary === "string" && frontmatter.summary.trim()
        ? frontmatter.summary.trim()
        : undefined;
    const declaredRootNodeId =
      typeof frontmatter.root_node_id === "string" && frontmatter.root_node_id.trim()
        ? frontmatter.root_node_id.trim()
        : undefined;

    const memberPosition = typeof member.position === "string" ? member.position : undefined;
    agents.push({
      name: declaredName ?? (typeof member.name === "string" ? member.name : undefined) ?? basename(checkoutPath),
      ...(declaredSummary ? { summary: declaredSummary } : {}),
      agreement: declaredAgreement,
      ...(root.root_node_id || declaredRootNodeId
        ? { root_node_id: root.root_node_id ?? declaredRootNodeId }
        : {}),
      sha: root.sha,
      path: checkoutPath,
      ...(memberPosition ? { position: memberPosition } : {}),
    });
  }

  return { agents, unresolved };
}

export function formatMapAgentsText(result: MapAgentsResult): string {
  const lines: string[] = [];
  if (result.agents.length > 0) {
    for (const agent of result.agents) {
      const summaryLine = agent.summary ? `\n  ${agent.summary}` : "";
      const pathLine = agent.path ? `\n  ${agent.path}` : "";
      lines.push(`${agent.name} (${agent.agreement}) → ${agent.root_node_id ?? agent.sha}${summaryLine}${pathLine}`);
    }
  }

  if (result.unresolved.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Unresolved roots:");
    for (const u of result.unresolved) {
      const id = u.root_node_id ?? u.repo ?? u.sha;
      const reasonText =
        u.reason === "unavailable_pin"
          ? `pin unavailable (${u.sha.slice(0, 8)})`
          : u.reason === "git_error"
            ? `git error: ${u.detail ?? "unknown"}`
            : "unbound (no local checkout)";
      lines.push(`  ${id} — ${reasonText}`);
    }
  }

  if (lines.length === 0) {
    return "No agents.";
  }

  return lines.join("\n");
}
