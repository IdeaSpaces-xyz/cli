import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  assembleContentFocus,
  assembleContentLook,
  inspectMarkdown,
  parseFrontmatter,
  renderContentFocus,
  renderContentLook,
  stripFrontmatter,
  summarizeMarkdown,
  type ContentFocusResult,
  type ContentLookManifest,
  type ContentLookResult,
  type ContentLookTarget,
  type ContractSource,
  type MapDepth,
} from "@ideaspaces/protocol";
import { preferredContractSource } from "../contract-source.js";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";
import { buildFrameMarkdownTarget } from "../commands/look.js";
import { findThreadPost, localText, threadFrame } from "../commands/threads.js";
import {
  computeBranches,
  findChildThreads,
  findNewestSnapshot,
  loadThread,
  resolveThreadParent,
} from "./threads.js";

/**
 * Reading Content at a commit, not in a working tree.
 *
 * The protocol owns what a Note or a directory looks like at each rung, and it reads a
 * filesystem. So the commit's Markdown and `_agent/` files under the target are written to a
 * private folder, the protocol's own look or focus runs there, and every path in the result is
 * relabelled. Nothing is read from, or written to, the checkout's working tree or index.
 *
 * TODO(protocol-reader): if the protocol's look, focus and tree take a reader instead of a
 * filesystem, this module goes and the relabelling with it.
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
   * What stands in for the private folder in rendered text and JSON: `root` for the folder
   * itself, `prefix` before a path inside it (`@notes//` for both, or a checkout path and the
   * same path with a separator).
   */
  label: { root: string; prefix: string };
}

export interface CommitLookOptions {
  depth: MapDepth;
  contractSource?: ContractSource;
  maxChildren?: number;
  limit?: number;
  order?: "newer" | "older";
  since?: string;
  post?: string;
}

/** Look at one Note or directory as it is in a commit, at one rung. */
export async function lookAtCommit(target: CommitReadTarget, options: CommitLookOptions): Promise<CommitLook> {
  const isThread = target.position.startsWith("_threads/") || target.position === "_threads";
  const wholeTree = isThread || (target.kind === "directory" && (options.depth === "children" || options.depth === "full"));
  return withSnapshot(target, wholeTree, async (dir) => {
    const position = join(dir, target.position);
    const relabel = relabeller(dir, target.label);

    let focused = await assembleContentFocus({
      position: dir,
      treeMaxEntries: 0,
      ...(options.contractSource ? { contractSource: options.contractSource } : {}),
    });
    if (focused?.status === "contract_choice_required" && !options.contractSource) {
      const preferred = preferredContractSource(focused.availableSources);
      if (preferred) {
        focused = await assembleContentFocus({ position: dir, treeMaxEntries: 0, contractSource: preferred });
      }
    }
    if (!focused) return { status: "not_content", reason: `Cannot frame commit snapshot for ${target.position}.` };
    if (focused.status !== "ok") return { status: "diagnostic", text: relabel(renderContentFocus(focused)) };

    const reference = { ...focused, tree: null };

    // Frame files under _threads/ (README.md or _agent/agreement.md)
    if (/^_threads\/[^/]+\/(README\.md|_agent\/agreement\.md)$/.test(target.position)) {
      if (!existsSync(position)) {
        return { status: "not_content", reason: `${target.position} is missing at ${target.commit}.` };
      }
      const content = readFileSync(position, "utf8");
      const targetManifest = buildFrameMarkdownTarget(position, target.position, content, options.depth);
      const looked: ContentLookManifest = {
        status: "ok",
        kind: "content-look",
        contractRole: "reference",
        reference,
        target: targetManifest,
      };
      return {
        status: "ok",
        text: relabel(renderContentLook(looked)),
        result: relabelDeep(looked, relabelValue(dir, target.label, relabel)),
      };
    }

    // Thread folders (_threads/<slug>)
    if (/^_threads\/[^/]+$/.test(target.position)) {
      if (!existsSync(position) || !statSync(position).isDirectory()) {
        return { status: "not_content", reason: `${target.position} is not a Thread directory.` };
      }
      let thread;
      try {
        thread = loadThread(position);
      } catch (err) {
        return { status: "diagnostic", text: `Thread ${target.position} cannot be read: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (options.post) {
        const matched = findThreadPost(thread.posts, options.post);
        if (!matched) return { status: "not_content", reason: `Post ${options.post} not found in Thread ${thread.slug}.` };
        const raw = readFileSync(join(position, matched.path), "utf8");
        const childThreads = findChildThreads(position, matched.id);
        let humanText = raw;
        if (childThreads.length > 0) {
          humanText += `\n\nChild Threads (${childThreads.length} of ${childThreads.length} known):\n` +
            childThreads.map((c) => `  ${c.slug}  ${c.name}\n    summary: ${c.summary || "(no summary)"}`).join("\n");
        }
        return {
          status: "ok",
          text: relabel(humanText),
          result: {
            status: "ok",
            kind: "content-look",
            contractRole: "reference",
            reference,
            target: {
              placement: "history",
              path: join(position, matched.path),
              position: `${target.position}/${matched.path}`,
              kind: "markdown",
              depth: options.depth,
              revision: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
              name: matched.frontmatter.name ?? matched.id,
              summary: matched.frontmatter.summary ?? null,
              surface: stripFrontmatter(raw),
              member: { position: `${target.position}/${matched.path}`, depth: options.depth },
            },
          },
        };
      }

      const order = options.order ?? "newer";
      if (options.order !== undefined && order !== "newer" && order !== "older") {
        return { status: "diagnostic", text: "--order must be newer or older" };
      }
      if (options.since && order === "newer") {
        return { status: "diagnostic", text: "--since advances forward in time; use --order older to continue a page, or omit --since for the newest page." };
      }

      let posts = [...thread.posts];
      if (options.since) {
        const at = posts.findIndex((p) => p.id === options.since);
        if (at !== -1) posts = posts.slice(at + 1);
        else if (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(options.since) && !Number.isNaN(Date.parse(options.since))) {
          const cutoff = Date.parse(options.since);
          posts = posts.filter((p) => p.date && Date.parse(p.date) > cutoff);
        } else {
          return { status: "diagnostic", text: `--since needs a post id in this Thread or a valid ISO date: ${options.since}` };
        }
      }
      if (order === "newer") posts.reverse();
      const limit = options.limit ?? (options.depth === "surface" ? 5 : 10);
      if (limit <= 0) return { status: "diagnostic", text: "--limit must be a positive integer" };
      const boundedPosts = options.depth === "summary" && !options.since ? [] : posts.slice(0, limit);

      const frame = options.depth === "name" ? threadFrame(thread) : undefined;
      const parent = resolveThreadParent(position);
      const snapshot = findNewestSnapshot(thread.posts);
      const allBranches = options.depth === "children" ? computeBranches(thread.posts) : [];
      const allChildThreads = options.depth === "children" ? findChildThreads(position) : [];
      const branches = allBranches.slice(0, limit);
      const childThreads = allChildThreads.slice(0, limit);

      let text = localText(thread, boundedPosts, options.depth as any, {
        frame,
        parent,
        snapshot,
        branches,
        childThreads,
        branchTotal: allBranches.length,
        childThreadTotal: allChildThreads.length,
        filtered: Boolean(options.since || options.limit || options.order),
      });

      if (thread.warnings.length) {
        text += "\n" + thread.warnings.join("\n");
      }

      return {
        status: "ok",
        text: relabel(text),
        result: {
          status: "ok",
          kind: "content-look",
          contractRole: "reference",
          reference,
          target: {
            placement: "history",
            path: position,
            position: target.position,
            kind: "directory",
            depth: options.depth,
            revision: `sha256:${createHash("sha256").update(text).digest("hex")}`,
            name: thread.name,
            summary: thread.summary,
            member: { position: target.position, depth: options.depth },
          },
        },
      };
    }

    // Direct post lookup by subpath (_threads/<slug>/<entry>)
    if (/^_threads\/[^/]+\/[^/]+$/.test(target.position)) {
      const match = /^(_threads\/[^/]+)\/(.+)$/.exec(target.position)!;
      const threadSlugPos = match[1];
      const postSpec = match[2];
      const threadDir = join(dir, threadSlugPos);
      if (existsSync(threadDir)) {
        let thread;
        try {
          thread = loadThread(threadDir);
        } catch { /* proceed */ }
        if (thread) {
          const matched = findThreadPost(thread.posts, postSpec);
          if (matched) {
            const raw = readFileSync(join(threadDir, matched.path), "utf8");
            return {
              status: "ok",
              text: relabel(raw),
              result: {
                status: "ok",
                kind: "content-look",
                contractRole: "reference",
                reference,
                target: {
                  placement: "history",
                  path: join(threadDir, matched.path),
                  position: `${threadSlugPos}/${matched.path}`,
                  kind: "markdown",
                  depth: options.depth,
                  revision: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
                  name: matched.frontmatter.name ?? matched.id,
                  summary: matched.frontmatter.summary ?? null,
                  surface: stripFrontmatter(raw),
                  member: { position: `${threadSlugPos}/${matched.path}`, depth: options.depth },
                },
              },
            };
          }
        }
      }
    }

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
    if (looked.status !== "ok") return { status: "diagnostic", text: relabel(renderContentLook(looked)) };
    return { status: "ok", text: relabel(renderContentLook(looked)), result: relabelDeep(looked, relabelValue(dir, target.label, relabel)) };
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
    return { status: "ok", text: relabel(renderContentFocus(focus)), result: relabelDeep(focus, relabelValue(dir, target.label, relabel)) };
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
  spawnSync(gitBinary(), ["-C", cwd, ...args], {
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
  const isThread = position.startsWith("_threads/") || position === "_threads";
  const threadRoot = isThread && position.includes("/") ? position.split("/").slice(0, 2).join("/") : position;
  const specs = [
    ...agentDirs,
    ...(isThread
      ? [threadRoot]
      : kind === "file"
        ? [position]
        : wholeTree
          ? [position]
          : [`${below}README.md`]),
  ];

  // A whole-tree read of the root lists everything; otherwise only the framing and the target.
  const pathspecs = specs.includes(".") ? [] : ["--", ...specs.map((spec) => `:(literal)${spec}`)];
  const listed = git(checkoutPath, ["ls-tree", "-r", "-z", "--full-tree", commit, ...pathspecs]);
  if (listed.error || listed.status !== 0) return gitFailure(listed, "git ls-tree");

  const files: { path: string; object: string }[] = [];
  for (const line of listed.stdout.toString("utf8").split("\0")) {
    // Regular files only: a symlink (120000) or submodule (160000) is not Content and is not
    // followed, so a symlinked `_agent/` frames nothing here, as it would not in a clone.
    const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    if (!match) continue;
    const path = match[3];
    const framing = agentDirs.some((agent) => path.startsWith(`${agent}/`));
    if (framing || path === position || path.startsWith(`${position}/`) || path.endsWith(".md") || path.startsWith("_threads/")) files.push({ path, object: match[2] });
  }
  // A directory is in the commit even when nothing below it is written out.
  if (kind === "directory") mkdirSync(join(dir, position), { recursive: true });
  if (!files.length) {
    return initRepository(dir);
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
    if (newline === -1) return { status: "git_error", reason: `git cat-file ended before ${file.path}.` };
    const header = out.subarray(offset, newline).toString("utf8");
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) return { status: "git_error", reason: `git cat-file returned ${JSON.stringify(header)} for ${file.path}.` };
    const size = Number(match[1]);
    const start = newline + 1;
    if (start + size > out.length) return { status: "git_error", reason: `git cat-file ended inside ${file.path} at ${commit}.` };
    const destination = join(dir, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, out.subarray(start, start + size));
    offset = start + size + 1;
  }
  return initRepository(dir);
}

/**
 * The protocol frames a position by its repository root; the snapshot is one, with no history.
 * Without it the frame would silently move to the nearest `_agent/`, so a failure is an error.
 */
function initRepository(dir: string): CommitReadFailure | undefined {
  const made = git(dir, ["init", "-q"]);
  return made.error || made.status !== 0 ? gitFailure(made, "git init") : undefined;
}

/**
 * Swap the private folder for the label. A prefix swap, not a path match: the end of a path in
 * prose cannot be found (positions may hold spaces), and nothing after the prefix needs to be.
 * Safe as a plain replace only because `dir` holds mkdtemp's random suffix; never pass a short,
 * guessable folder here.
 */
export function relabeller(dir: string, label: { root: string; prefix: string }): (text: string) => string {
  // On Windows the protocol reports the folder both as Node spells it (C:\…) and as Git does (C:/…).
  const spellings = [...new Set([dir, dir.split("\\").join("/")])];
  return (text) =>
    spellings.reduce(
      (out, spelling) =>
        out.split(`${spelling}/`).join(label.prefix).split(`${spelling}\\`).join(label.prefix).split(spelling).join(label.root),
      text,
    );
}

/**
 * For structured results: a value that is itself a path under the folder is relabelled whole, and
 * after an address prefix its separators become `/` — an address is never spelled with `\`.
 * Anything else gets the text relabel.
 */
function relabelValue(
  dir: string,
  label: { root: string; prefix: string },
  relabel: (text: string) => string,
): (value: string) => string {
  const spellings = [...new Set([dir, dir.split("\\").join("/")])];
  return (value) => {
    const spelling = spellings.find((candidate) => value === candidate || value.startsWith(`${candidate}/`) || value.startsWith(`${candidate}\\`));
    if (!spelling) return relabel(value);
    const rest = value.slice(spelling.length + 1);
    if (!rest) return label.root;
    return label.prefix + (label.prefix.startsWith("@") ? rest.split("\\").join("/") : rest);
  };
}

function relabelDeep<T>(value: T, relabel: (text: string) => string): T {
  if (typeof value === "string") return relabel(value) as T;
  if (Array.isArray(value)) return value.map((item) => relabelDeep(item, relabel)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relabelDeep(item, relabel)])) as T;
  }
  return value;
}

