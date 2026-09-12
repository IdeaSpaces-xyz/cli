import {
  evaluateRootIdentity,
  inspectFrontmatterSyntax,
  isValidRootNodeId,
  mintRootNodeId,
  parseFrontmatter,
  type RootIdentityEvaluation,
} from "@ideaspaces/protocol";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, getDefaultApiUrl } from "./auth/credentials.js";
import { preferredContractSource } from "./contract-source.js";
import { findSpaceFor } from "./auth/spaces.js";
import { originUrl } from "./git.js";
import { rootNodeIdFromGitUrl } from "./repo-locator.js";

const FOUNDATION_PATH = "_agent/foundation.md";
const AGREEMENT_PATH = "_agent/agreement.md";
const INVALID_DECLARATION = Object.freeze({ invalid_root_identity_declaration: true });

export interface RootIdentityDeclarationState {
  head: unknown;
  index: unknown;
  worktree: unknown;
  dirty: boolean;
}

export interface LocalRootIdentityReport extends RootIdentityEvaluation {
  root_node_id: string | null;
  contract_source: "foundation" | "agreement" | null;
  entrypoint_conflict: boolean;
  declaration: RootIdentityDeclarationState;
  canonical_origin: string | null;
  local_registry: string | null;
  origin_url: string | null;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  if (result.error) throw new Error(`git ${args.join(" ")}: ${result.error.message}`);
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function declarationFromContent(content: string | null): unknown {
  if (content === null) return undefined;
  const syntax = inspectFrontmatterSyntax(content);
  if (syntax.status === "malformed") return INVALID_DECLARATION;
  return parseFrontmatter(content)?.root_node_id;
}

function optionalGitBlob(cwd: string, object: string): string | null {
  // One probe per revision matters on Windows, where process startup dominates
  // this read. `git show` distinguishes presence in its exit status; spawn
  // failures still throw, while a missing HEAD/path is valid absence.
  const shown = runGit(cwd, ["show", object]);
  return shown.ok ? shown.stdout : null;
}

function headContract(cwd: string, path: string): string | null {
  return optionalGitBlob(cwd, `HEAD:${path}`);
}

function indexContract(cwd: string, path: string): string | null {
  return optionalGitBlob(cwd, `:${path}`);
}

function worktreeContract(cwd: string, path: string): string | null {
  const absolute = join(cwd, path);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, "utf-8");
}

function pathPresentInAnyRevision(
  cwd: string,
  path: string,
  worktree: string | null,
): boolean {
  if (worktree !== null) return true;
  // A missing worktree file can still be a staged or unstaged deletion. One
  // bounded status probe preserves that fact without reading all revisions for
  // both candidate entrypoints.
  const status = runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--", path]);
  return status.ok && status.stdout.trim().length > 0;
}

function sameDeclaration(left: unknown, right: unknown): boolean {
  if (left === INVALID_DECLARATION || right === INVALID_DECLARATION) return left === right;
  return Object.is(left, right);
}

/** Add root identity to a known-valid contract entrypoint without reformatting frontmatter. */
export function declareRootIdentity(content: string, rootNodeId: string): string {
  if (!isValidRootNodeId(rootNodeId)) throw new Error("Refusing to write an invalid root_node_id");
  const syntax = inspectFrontmatterSyntax(content);
  if (syntax.status !== "valid") throw new Error("Contract entrypoint must have valid frontmatter before identity can be declared");
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) throw new Error("Contract entrypoint frontmatter could not be read");
  if (frontmatter.root_node_id !== undefined) {
    throw new Error("Refusing to replace an existing root_node_id declaration");
  }

  const newline = content.startsWith("---\r\n") ? "\r\n" : "\n";
  const closing = content.indexOf(`${newline}---`, 3);
  if (closing < 0) throw new Error("Contract entrypoint frontmatter has no closing delimiter");
  return `${content.slice(0, closing)}${newline}root_node_id: ${rootNodeId}${content.slice(closing)}`;
}

export function mintDeclaredRootIdentity(content: string): { content: string; rootNodeId: string } {
  const rootNodeId = mintRootNodeId();
  return { content: declareRootIdentity(content, rootNodeId), rootNodeId };
}

/**
 * Read local identity evidence without network access or mutation.
 *
 * HEAD is publication authority. Agreement is preferred when present in any
 * local revision; otherwise Foundation remains the compatibility source. A
 * cheap presence probe selects one path before its HEAD/index/worktree values
 * are read, avoiding a full revision walk for both candidates.
 */
export function inspectLocalRootIdentity(cwd: string, apiUrl?: string): LocalRootIdentityReport {
  const agreementWorktree = worktreeContract(cwd, AGREEMENT_PATH);
  const agreementPresent = pathPresentInAnyRevision(
    cwd,
    AGREEMENT_PATH,
    agreementWorktree,
  );
  const foundationWorktree = agreementPresent
    ? null
    : worktreeContract(cwd, FOUNDATION_PATH);
  const foundationPresent = agreementPresent
    ? false
    : pathPresentInAnyRevision(cwd, FOUNDATION_PATH, foundationWorktree);
  const contractSource = preferredContractSource([
    ...(agreementPresent ? (["agreement"] as const) : []),
    ...(foundationPresent ? (["foundation"] as const) : []),
  ]);
  const selectedPath = contractSource === "agreement"
    ? AGREEMENT_PATH
    : contractSource === "foundation"
      ? FOUNDATION_PATH
      : null;
  const selectedWorktree = contractSource === "agreement"
    ? agreementWorktree
    : contractSource === "foundation"
      ? foundationWorktree
      : null;
  const selectedHead = selectedPath ? headContract(cwd, selectedPath) : null;
  const selectedIndex = selectedPath ? indexContract(cwd, selectedPath) : null;
  const head = declarationFromContent(selectedHead);
  const index = declarationFromContent(selectedIndex);
  const worktree = declarationFromContent(selectedWorktree);
  const foundationHead = contractSource === "agreement"
    ? declarationFromContent(headContract(cwd, FOUNDATION_PATH))
    : head;
  const agreementHead = contractSource === "agreement" ? head : undefined;
  const entrypointConflict =
    isValidRootNodeId(foundationHead) &&
    isValidRootNodeId(agreementHead) &&
    foundationHead !== agreementHead;
  const dirty = !sameDeclaration(head, index) || !sameDeclaration(head, worktree);

  const record = findSpaceFor(cwd);
  const localRegistry = record?.root_node_id;
  const origin = originUrl(cwd);
  const configuredApiUrl = apiUrl ?? loadConfig()?.apiUrl ?? getDefaultApiUrl();
  const canonicalOrigin = origin
    ? rootNodeIdFromGitUrl(origin, configuredApiUrl) ?? undefined
    : undefined;
  const evaluation = evaluateRootIdentity({
    declaration: entrypointConflict ? INVALID_DECLARATION : head,
    canonicalOrigin,
    localRegistry,
  });

  return {
    ...evaluation,
    root_node_id: evaluation.rootNodeId ?? null,
    contract_source: contractSource,
    entrypoint_conflict: entrypointConflict,
    declaration: {
      head: head === undefined ? null : head,
      index: index === undefined ? null : index,
      worktree: worktree === undefined ? null : worktree,
      dirty,
    },
    canonical_origin: canonicalOrigin ?? null,
    local_registry: localRegistry ?? null,
    origin_url: origin,
  };
}
