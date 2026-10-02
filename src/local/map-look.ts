import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  assembleContentFocus,
  assembleContentLook,
  renderContentFocus,
  renderContentLook,
  type ContentFocusResult,
  type ContentLookResult,
  type ContractSource,
  type MapDepth,
} from "@ideaspaces/protocol";
import { preferredContractSource } from "../contract-source.js";
import { sanitizedGitEnvironment } from "../git.js";

/**
 * Reading Content at a commit, not in a working tree.
 *
 * The protocol owns what a Note or a directory looks like at each rung, and it reads a
 * filesystem. So the commit's Markdown and `_agent/` files under the target are written to a
 * private folder, the protocol's own look or focus runs there, and every path in the result is
 * relabelled. Nothing is read from, or written to, the checkout's working tree or index.
 */

/** Total bytes one commit read may write out. */
export const COMMIT_READ_MAX_BYTES = 32 * 1024 * 1024;

export type CommitReadFailure = { status: "too_large" | "git_error"; reason: string };

export type CommitLook =
  | { status: "ok"; text: string; result: ContentLookResult & { status: "ok" } }
  | { status: "not_content"; reason: string }
  | { status: "diagnostic"; text: string }
  | CommitReadFailure;

export type CommitFocus =
  | { status: "ok"; text: string; result: ContentFocusResult & { status: "ok" } }
  | { status: "not_content"; reason: string }
  | { status: "diagnostic"; text: string }
  | CommitReadFailure;

export interface CommitReadTarget {
  checkoutPath: string;
  commit: string;
  /** Repository-relative position; `.` for the root. */
  position: string;
  kind: "file" | "directory";
  /**
   * What stands in for the private folder in rendered text and JSON. Called with a
   * repository-relative position (`.` for the root).
   */
  label: (position: string) => string;
}

export interface CommitLookOptions {
  depth: MapDepth;
  contractSource?: ContractSource;
  maxChildren?: number;
}

/** Look at one Note or directory as it is in a commit, at one rung. */
export async function lookAtCommit(target: CommitReadTarget, options: CommitLookOptions): Promise<CommitLook> {
  const wholeTree = target.kind === "directory" && (options.depth === "children" || options.depth === "full");
  return withSnapshot(target, wholeTree, async (dir) => {
    const position = join(dir, target.position);
    const request = {
      position,
      depth: options.depth,
      ...(options.contractSource ? { contractSource: options.contractSource } : {}),
      ...(options.maxChildren !== undefined ? { maxChildren: options.maxChildren } : {}),
    };
    let looked = await assembleContentLook(request);
    if (looked?.status === "contract_choice_required" && !options.contractSource) {
      const preferred = preferredContractSource(looked.availableSources);
      if (preferred) looked = await assembleContentLook({ ...request, contractSource: preferred });
    }
    if (!looked) return { status: "not_content", reason: `${target.position} is not a Markdown Note or Content directory.` };
    const relabel = relabeller(dir, target.label);
    if (looked.status !== "ok") return { status: "diagnostic", text: relabel(renderContentLook(looked)) };
    return { status: "ok", text: relabel(renderContentLook(looked)), result: relabelDeep(looked, relabel) };
  });
}

/** Focus on one directory as it is in a commit: its contract, depth-one tree and skills, as reference. */
export async function focusAtCommit(target: CommitReadTarget, contractSource?: ContractSource): Promise<CommitFocus> {
  if (target.kind !== "directory") return { status: "not_content", reason: `${target.position} is not a directory.` };
  return withSnapshot(target, true, async (dir) => {
    const position = join(dir, target.position);
    let focus = await assembleContentFocus({ position, ...(contractSource ? { contractSource } : {}) });
    if (focus?.status === "contract_choice_required" && !contractSource) {
      const preferred = preferredContractSource(focus.availableSources);
      if (preferred) focus = await assembleContentFocus({ position, contractSource: preferred });
    }
    if (!focus) return { status: "not_content", reason: `${target.position} is not a Content position.` };
    const relabel = relabeller(dir, target.label);
    if (focus.status !== "ok") return { status: "diagnostic", text: relabel(renderContentFocus(focus)) };
    return { status: "ok", text: relabel(renderContentFocus(focus)), result: relabelDeep(focus, relabel) };
  });
}

async function withSnapshot<T>(
  target: CommitReadTarget,
  wholeTree: boolean,
  read: (dir: string) => Promise<T>,
): Promise<T | CommitReadFailure> {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ideaspaces-commit-read-")));
  // Named as the checkout is, so a root without a README is named as a path look names it.
  const dir = join(parent, basename(target.checkoutPath) || "root");
  try {
    mkdirSync(dir);
    const written = writeSnapshot(target, wholeTree, dir);
    if (written) return written;
    return await read(dir);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

const git = (cwd: string, args: string[], options: { input?: string; maxBuffer?: number } = {}) =>
  spawnSync("git", ["-C", cwd, ...args], {
    env: sanitizedGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    ...(options.input === undefined ? {} : { input: options.input }),
  });

function gitFailure(result: ReturnType<typeof git>, what: string): CommitReadFailure {
  const stderr = result.stderr ? result.stderr.toString("utf8").trim() : "";
  return { status: "git_error", reason: result.error?.message || stderr || `${what} failed` };
}

/** The folders whose `_agent/` frames a position: the root, then each folder down to the target. */
function framingFolders(position: string, kind: "file" | "directory"): string[] {
  const parts = position === "." ? [] : position.split("/");
  const folders = kind === "file" ? parts.slice(0, -1) : parts;
  return ["", ...folders.map((_, index) => folders.slice(0, index + 1).join("/"))];
}

/**
 * Write the commit's files a look at `position` reads: every `_agent/` file framing it, the
 * Note itself, or a directory's README — and, for a tree, every Markdown file below it, since
 * the protocol counts them. Returns a failure, or nothing when the folder is ready.
 */
function writeSnapshot(target: CommitReadTarget, wholeTree: boolean, dir: string): CommitReadFailure | undefined {
  const { checkoutPath, commit, position, kind } = target;
  const agentDirs = framingFolders(position, kind).map((folder) => (folder ? `${folder}/_agent` : "_agent"));
  const below = position === "." ? "" : `${position}/`;
  const specs = [...agentDirs, ...(kind === "file" ? [position] : wholeTree ? [position] : [`${below}README.md`])];

  // A whole-tree read of the root lists everything; otherwise only the framing and the target.
  const pathspecs = specs.includes(".") ? [] : ["--", ...specs.map((spec) => `:(literal)${spec}`)];
  const listed = git(checkoutPath, ["ls-tree", "-r", "-z", "--full-tree", commit, ...pathspecs]);
  if (listed.error || listed.status !== 0) return gitFailure(listed, "git ls-tree");

  const files: { path: string; object: string }[] = [];
  for (const line of listed.stdout.toString("utf8").split("\0")) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    if (!match) continue;
    const path = match[3];
    const framing = agentDirs.some((agent) => path.startsWith(`${agent}/`));
    if (framing || path === position || path.endsWith(".md")) files.push({ path, object: match[2] });
  }
  // A directory is in the commit even when nothing below it is written out.
  if (kind === "directory") mkdirSync(join(dir, position), { recursive: true });
  if (!files.length) {
    initRepository(dir);
    return undefined;
  }

  const shown = git(checkoutPath, ["cat-file", "--batch"], {
    input: files.map((file) => file.object).join("\n") + "\n",
    maxBuffer: COMMIT_READ_MAX_BYTES + files.length * 128,
  });
  if (shown.error && (shown.error as NodeJS.ErrnoException).code === "ENOBUFS") {
    return { status: "too_large", reason: `Reading ${position} at ${commit} would write more than ${COMMIT_READ_MAX_BYTES} bytes.` };
  }
  if (shown.error || shown.status !== 0) return gitFailure(shown, "git cat-file");

  const out = shown.stdout;
  let offset = 0;
  for (const file of files) {
    const newline = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, newline).toString("utf8");
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) return { status: "git_error", reason: `git cat-file returned ${JSON.stringify(header)} for ${file.path}.` };
    const size = Number(match[1]);
    const start = newline + 1;
    const destination = join(dir, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, out.subarray(start, start + size));
    offset = start + size + 1;
  }
  initRepository(dir);
  return undefined;
}

/** The protocol frames a position by its repository root; the snapshot is one, with no history. */
function initRepository(dir: string): void {
  git(dir, ["init", "-q"]);
}

function relabeller(dir: string, label: (position: string) => string): (text: string) => string {
  const pattern = new RegExp(`${escapeRegExp(dir)}((?:[\\\\/][^\\s"'\`)\\]]*)?)`, "g");
  return (text) =>
    text.replace(pattern, (_match, rest: string) => {
      const position = rest.replace(/^[\\/]/, "").split("\\").join("/");
      return label(position || ".");
    });
}

function relabelDeep<T>(value: T, relabel: (text: string) => string): T {
  if (typeof value === "string") return relabel(value) as T;
  if (Array.isArray(value)) return value.map((item) => relabelDeep(item, relabel)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relabelDeep(item, relabel)])) as T;
  }
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
