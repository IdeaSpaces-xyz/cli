import { basename } from "node:path";
import {
  inspectFrontmatterSyntax,
  parseFrontmatter,
  type MapBlock,
} from "@ideaspaces/protocol";
import type { LoadedMapNote } from "./map-note.js";
import { readMapRoot } from "./map-resolve.js";
import { inspectSpaceMapRoots } from "./space-map.js";

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
  sha?: string;
  path?: string;
  reason: "unbound" | "unavailable_pin" | "git_error";
  detail?: string;
}

export interface MapAgentsResult {
  agents: MapAgentListing[];
  unresolved: MapUnresolvedRoot[];
}

export interface CheckoutResolverOptions {
  /** Where root checkouts are looked for: the folder, folders below it, then the registry. */
  cwd?: string;
}

function isMapBlock(value: unknown): value is MapBlock {
  return typeof value === "object" && value !== null && "roots" in value && "members" in value;
}

/**
 * Project the agent-kind roots included in a Space Map selection.
 *
 * Inspects author-declared `agreement` at the exact Map pin commit in each
 * root's local checkout, located by identity through the shared Map reader,
 * without network access or HEAD substitution.
 */
export function projectMapAgents(
  mapInput: LoadedMapNote | MapBlock,
  options?: CheckoutResolverOptions,
): MapAgentsResult {
  const mapBlock: MapBlock = "map" in mapInput && isMapBlock(mapInput.map) ? mapInput.map : (mapInput as MapBlock);
  const roots = mapBlock.roots ?? [];
  const members = mapBlock.members ?? [];

  const located = inspectSpaceMapRoots(roots, options?.cwd ?? process.cwd());

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
    const identity = {
      ...(root.root_node_id ? { root_node_id: root.root_node_id } : {}),
      ...(root.repo ? { repo: root.repo } : {}),
      sha: root.sha,
    };

    const read = readMapRoot(located[rootIndex], "_agent/agreement.md", root.sha ? "pin" : "head");
    const checkoutPath = read.checkoutPath;
    if (!checkoutPath) {
      unresolved.push({ ...identity, reason: "unbound", detail: "No local checkout found" });
      continue;
    }
    if (read.status === "pin_absent") {
      unresolved.push({
        ...identity,
        path: checkoutPath,
        reason: "unavailable_pin",
        detail: `Pin ${root.sha} not found in local checkout`,
      });
      continue;
    }
    if (read.status === "unreachable") {
      unresolved.push({
        ...identity,
        path: checkoutPath,
        reason: "git_error",
        detail: read.reason ?? "git command failed",
      });
      continue;
    }
    if ((read.status !== "checkout_at_pin" && read.status !== "checkout_at_head") || read.kind !== "file") {
      continue;
    }

    const content = read.content ?? "";
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
      sha: read.commit!, // selected pin, or the observed HEAD for an unpinned root
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
      const id = u.root_node_id ?? u.repo ?? u.sha ?? "unidentified root";
      const reasonText =
        u.reason === "unavailable_pin"
          ? `pin unavailable (${u.sha?.slice(0, 8) ?? "unknown"})`
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
