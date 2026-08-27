import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  LocalEffectCapabilities,
  LocalEffectError,
  LocalEffectPartial,
  LocalGitRunner,
} from "@ideaspaces/protocol";
import { nodeLocalEffectFileSystem } from "@ideaspaces/protocol/local-effects";
import { GIT_MISSING_HINT, sanitizedGitEnvironment } from "./git.js";
import type { Output } from "./output.js";
import type { GlobalFlags } from "./types.js";

/**
 * The CLI's explicit stock-Git capability for protocol local effects.
 *
 * Executable selection belongs to the terminal adapter: the protocol receives
 * this runner and never discovers Git, identity, credentials, or network state.
 */
function localEffectGitEnvironment(): NodeJS.ProcessEnv {
  // The request's root, index, author, and committer are explicit protocol
  // inputs. Git's environment overrides must not silently replace them.
  return sanitizedGitEnvironment();
}

export const localEffectGitRunner: LocalGitRunner = async (root, args) => {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: localEffectGitEnvironment(),
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      stdout: "",
      stderr: code === "ENOENT" ? GIT_MISSING_HINT : `git could not run: ${result.error.message}`,
      code: null,
    };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
};

export const localEffectCapabilities: LocalEffectCapabilities = {
  git: localEffectGitRunner,
  filesystem: nodeLocalEffectFileSystem,
};

/** Exact staged path set for CLI `--all`, parsed without path-quoting loss. */
export async function stagedPathsForEffects(root: string): Promise<string[]> {
  const result = await localEffectGitRunner(root, ["diff", "--cached", "--name-only", "-z"]);
  if (!result.ok) {
    throw new Error(result.stderr?.trim() || "Git could not read the staged path set.");
  }
  return result.stdout.split("\0").filter(Boolean);
}

/** Read Git's effective terminal identity through the sanitized runner. */
export async function gitIdentityConfigForEffects(root: string, key: string): Promise<string | null> {
  const result = await localEffectGitRunner(root, ["config", "--get", key]);
  if (result.code === 1) return null;
  if (!result.ok) {
    throw new Error(result.stderr?.trim() || `Git could not read ${key}.`);
  }
  return result.stdout.trim() || null;
}

/** Canonical absolute toplevel required by the protocol effect boundary. */
export function canonicalRepoRoot(cwd = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: localEffectGitEnvironment(),
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOENT" ? GIT_MISSING_HINT : result.error.message);
  }
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(result.stderr?.trim() || "not inside a git repository");
  }
  return realpathSync.native(result.stdout.trim());
}

/**
 * Resolve one CLI path spelling to the protocol's portable repo-relative form.
 * Missing leaf paths are allowed; confinement is lexical here and rechecked by
 * the protocol without following symlinks.
 */
export function toPortableRepoPath(input: string, root: string, cwd = process.cwd()): string | null {
  const invocationRoot = realpathSync.native(cwd);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(invocationRoot, input);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export type EffectFailure = LocalEffectError | LocalEffectPartial;

/** Emit a typed effect failure on stdout for JSON callers, stderr for people. */
export function emitEffectFailure(
  output: Output,
  global: GlobalFlags,
  failure: EffectFailure,
): void {
  if (global.json) {
    output.result(failure, "");
    return;
  }
  const where = failure.path ? ` (${failure.path})` : "";
  const lines = [
    `${failure.message}${where}`,
    `Code: ${failure.code}; phase: ${failure.phase}.`,
  ];
  if (failure.detail) lines.push(failure.detail);
  if (failure.status === "partial") lines.push(`Recovery: ${failure.recovery_hint}`);
  output.error(lines.join("\n"));
}

export function localEffectError(
  operation: "write_markdown" | "commit_paths",
  code: LocalEffectError["code"],
  phase: LocalEffectError["phase"],
  message: string,
  path?: string,
  detail?: string,
): LocalEffectError {
  return {
    status: "error",
    operation,
    affected_paths: [],
    code,
    phase,
    ...(path === undefined ? {} : { path }),
    message,
    ...(detail === undefined ? {} : { detail }),
  };
}
