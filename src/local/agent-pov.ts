import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { listClones } from "../auth/spaces.js";

export type AgentPovErrorCode =
  | "not_found"
  | "not_a_directory"
  | "missing_contract"
  | "symlink_escape"
  | "inaccessible";

export interface ValidAgentPov {
  valid: true;
  path: string;
  contractPath: string;
  contractType: "agreement" | "foundation";
}

export interface InvalidAgentPov {
  valid: false;
  code: AgentPovErrorCode;
  message: string;
}

export type AgentPovResult = ValidAgentPov | InvalidAgentPov;

export interface ValidateAgentPovOptions {
  cwd?: string;
  allowFoundation?: boolean;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Validate and canonicalize a point-of-view locator.
 *
 * Locators:
 * 1. Current repo (`.`, relative path, or absolute path).
 * 2. Registered local Space by root_node_id (12-hex or 24-hex), repo_id, or slug.
 *
 * Requirements:
 * - Target directory must exist and be accessible.
 * - Target must contain its own `_agent/agreement.md` (or compatibility `_agent/foundation.md`).
 * - Contract must be a regular file within the canonical space root (no symlink escape).
 */
export function validateAgentPov(
  pov: string,
  options: ValidateAgentPovOptions = {},
): AgentPovResult {
  const trimmed = pov.trim();
  if (!trimmed) {
    return {
      valid: false,
      code: "not_found",
      message: 'Agent point of view locator cannot be empty.',
    };
  }

  const cwd = options.cwd ?? process.cwd();
  let candidatePath: string | null = null;

  // 1. Direct path check (relative to cwd or absolute)
  const directCandidate = resolve(cwd, trimmed);
  if (existsSync(directCandidate)) {
    try {
      if (statSync(directCandidate).isDirectory()) {
        candidatePath = directCandidate;
      }
    } catch {
      /* inaccessible path */
    }
  }

  // 2. Search local registered spaces if not matched as direct path
  if (!candidatePath) {
    let candidateId = trimmed;
    if (candidateId.startsWith("agent:repo:")) {
      candidateId = candidateId.slice("agent:repo:".length);
    } else if (candidateId.startsWith("knowledge:repo:")) {
      candidateId = candidateId.slice("knowledge:repo:".length);
    } else if (candidateId.startsWith("repo:")) {
      candidateId = candidateId.slice("repo:".length);
    } else if (candidateId.includes("/repos/")) {
      const match = /\/repos\/(n_(?:[0-9a-f]{24}|[0-9a-f]{12}))(?:\.git|\/|\?|#|$)/.exec(candidateId);
      if (match) candidateId = match[1];
    }

    try {
      const clones = listClones();
      const found = clones.find((c) => {
        if (c.record.root_node_id && c.record.root_node_id === candidateId) return true;
        if ("repo_id" in c.record && c.record.repo_id === candidateId) return true;
        if ("slug" in c.record && c.record.slug === candidateId) return true;
        return false;
      });

      if (found && existsSync(found.path)) {
        if (statSync(found.path).isDirectory()) {
          candidatePath = found.path;
        }
      }
    } catch {
      /* ignore clone lookup failure */
    }
  }

  if (!candidatePath) {
    return {
      valid: false,
      code: "not_found",
      message: `Agent point of view "${pov}" could not be resolved to a local directory or registered Space.`,
    };
  }

  // Canonicalize directory
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync.native(candidatePath);
    const stat = statSync(canonicalDir);
    if (!stat.isDirectory()) {
      return {
        valid: false,
        code: "not_a_directory",
        message: `Agent point of view "${pov}" is not a directory.`,
      };
    }
  } catch (err) {
    return {
      valid: false,
      code: "inaccessible",
      message: `Agent point of view "${pov}" is inaccessible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Check entrypoint contract
  const agreementPath = join(canonicalDir, "_agent", "agreement.md");
  const foundationPath = join(canonicalDir, "_agent", "foundation.md");
  const hasAgreement = existsSync(agreementPath);
  const allowFoundation = options.allowFoundation ?? true;
  const hasFoundation = allowFoundation && existsSync(foundationPath);

  if (!hasAgreement && !hasFoundation) {
    return {
      valid: false,
      code: "missing_contract",
      message: `Agent point of view "${pov}" has no _agent/agreement.md contract.`,
    };
  }

  const contractType: "agreement" | "foundation" = hasAgreement ? "agreement" : "foundation";
  const contractFile = hasAgreement ? agreementPath : foundationPath;

  try {
    const stat = lstatSync(contractFile);
    // Check if contract is a regular file or symlink to a regular file
    const canonicalContract = realpathSync.native(contractFile);
    const targetStat = statSync(canonicalContract);
    if (!targetStat.isFile()) {
      return {
        valid: false,
        code: "missing_contract",
        message: `Agent point of view "${pov}" contract at _agent/${contractType}.md is not a regular file.`,
      };
    }

    if (!isWithin(canonicalDir, canonicalContract)) {
      return {
        valid: false,
        code: "symlink_escape",
        message: `Agent point of view "${pov}" contract escapes the repository root.`,
      };
    }

    return {
      valid: true,
      path: canonicalDir,
      contractPath: canonicalContract,
      contractType,
    };
  } catch (err) {
    return {
      valid: false,
      code: "inaccessible",
      message: `Agent point of view "${pov}" contract is inaccessible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Resolve a point-of-view locator to a canonical directory path on the local machine.
 * Returns null when the POV cannot be resolved or is invalid.
 */
export function resolveAgentPov(pov: string, options: ValidateAgentPovOptions = {}): string | null {
  const result = validateAgentPov(pov, options);
  return result.valid ? result.path : null;
}

/**
 * Revalidate that a previously resolved canonical POV path is still valid and has not drifted,
 * moved, or escaped before launch or resumption.
 */
export function revalidateAgentPov(
  canonicalPath: string,
  options: ValidateAgentPovOptions = {},
): AgentPovResult {
  return validateAgentPov(canonicalPath, options);
}
