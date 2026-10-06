import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseFrontmatter, parseMap, parseThreadPost, reconstructThreadTimeline, type ThreadPost, type ThreadKind } from "@ideaspaces/protocol";
import { stringify } from "yaml";
import { gitAvailability, markPrivateThreadsWorktree, sanitizedGitEnvironment } from "../git.js";
import { readCheckoutAt } from "./map-resolve.js";

const MAX_POST = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,100}$/;

export class NoAgreementError extends Error {}

export interface LocalThread {
  path: string;
  slug: string;
  name: string;
  summary: string;
  posts: ThreadPost[];
  closed: boolean;
  readme: string;
}

function git(cwd: string, args: string[]): string {
  const availability = gitAvailability();
  if (availability.state !== "usable") throw new Error(availability.hint);
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: sanitizedGitEnvironment() });
  if (result.status !== 0) throw new Error((result.stderr || result.error?.message || `git ${args[0]} failed`).trim());
  return result.stdout.trim();
}

/** An explicit local path never resolves through a symlink into another tree. */
function safeDirectory(path: string): string {
  const abs = resolve(path);
  // OS temp roots can have a symlink ancestor (/var → /private/var on macOS).
  // Refuse the selected entry itself; canonicalize ancestors and compare the
  // resulting Thread path against the canonical _threads/ boundary below.
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new Error(`Refusing symlink: ${abs}`);
  if (!existsSync(abs) || !lstatSync(abs).isDirectory()) throw new Error(`Thread directory not found: ${abs}`);
  return realpathSync(abs);
}

function safeFile(path: string): string {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`Refusing non-regular thread file: ${path}`);
  if (lstatSync(path).size > MAX_POST) throw new Error(`Thread file exceeds ${MAX_POST} bytes: ${path}`);
  return readFileSync(path, "utf8");
}

export function threadBase(cwd = process.cwd()): string {
  let at = safeDirectory(cwd);
  while (true) {
    if (existsSync(join(at, "_agent", "agreement.md"))) return at;
    const parent = dirname(at);
    if (parent === at) throw new NoAgreementError("No enclosing Agreement; run from an ideaspace with _agent/agreement.md.");
    at = parent;
  }
}

export function threadsDirectory(cwd = process.cwd()): string {
  return join(threadBase(cwd), "_threads");
}

export function resolveLocalThread(input: string, cwd = process.cwd()): string {
  const base = threadsDirectory(cwd);
  // Do not follow an _threads mount or symlink into another Space. An orphan
  // git worktree is a real directory and remains supported.
  safeDirectory(base);
  const path = input.includes("/") || input.startsWith(".") || isAbsolute(input) ? resolve(cwd, input) : join(base, input);
  const dir = safeDirectory(path);
  if (dirname(dir) !== base) throw new Error("A local Thread must be an immediate child of this Space's _threads/ directory.");
  return dir;
}

export function loadThread(dir: string): LocalThread {
  const path = safeDirectory(dir);
  const agreement = join(path, "_agent", "agreement.md");
  const readmePath = join(path, "README.md");
  if (!existsSync(agreement) || !existsSync(readmePath)) throw new Error(`Thread ${path} needs _agent/agreement.md and README.md.`);
  safeDirectory(join(path, "_agent"));
  safeFile(agreement);
  const readme = safeFile(readmePath);
  const fm = parseFrontmatter(readme);
  if (!fm) throw new Error(`Malformed README frontmatter: ${readmePath}`);
  const posts: ThreadPost[] = [];
  const seen = new Set<string>();
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "README.md" || entry.name === "_agent") continue;
    if (!entry.isFile() || !entry.name.endsWith(".md")) throw new Error(`Unexpected thread entry: ${entry.name}`);
    const parsed = parseThreadPost(safeFile(join(path, entry.name)), entry.name);
    if (parsed.status !== "valid") throw new Error(`Invalid post ${entry.name}: ${parsed.issues.join(", ")}`);
    if (seen.has(parsed.post.id)) throw new Error(`Duplicate post id: ${parsed.post.id}`);
    seen.add(parsed.post.id);
    posts.push(parsed.post);
  }
  const ordered = reconstructThreadTimeline(posts).posts;
  return {
    path, slug: basename(path), name: typeof fm.name === "string" ? fm.name : basename(path),
    summary: typeof fm.summary === "string" ? fm.summary : "", posts: ordered,
    closed: ordered.some((p) => p.kind === "closure"), readme,
  };
}

export function listLocal(cwd = process.cwd()): LocalThread[] {
  const base = threadsDirectory(cwd);
  if (!existsSync(base)) return [];
  safeDirectory(base);
  return readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => loadThread(join(base, e.name))).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function createThread(slug: string, about: string, cwd = process.cwd()): LocalThread {
  if (!SLUG.test(slug)) throw new Error("Thread slug must be lowercase letters, numbers and hyphens (1–101 characters).");
  if (!about.trim() || /[\r\n]/.test(about) || about.length > 200) throw new Error("--about must be a single-line title of at most 200 characters.");
  const base = threadsDirectory(cwd);
  if (existsSync(base)) safeDirectory(base);
  else mkdirSync(base);
  const dir = join(base, slug);
  mkdirSync(dir); // exclusive; never overwrite a Thread
  mkdirSync(join(dir, "_agent"));
  writeFileSync(join(dir, "_agent", "agreement.md"), `---\nname: ${stringify(`Agreement — ${about.trim()}`).trim()}\nsummary: Local Thread entry schema and immutable posts.\n---\n# ${about.trim()}\n\nPosts are immutable. Each carries an id and ISO date, optional in_reply_to and references, a kind, and an optional map. The README is the curated lens; update it deliberately.\n`, { flag: "wx" });
  writeFileSync(join(dir, "README.md"), stringify({ name: about.trim(), summary: about.trim() }).replace(/^/, "---\n") + "---\n\n# " + about.trim() + "\n", { flag: "wx" });
  return loadThread(dir);
}

function references(parents: ThreadPost[]): string[] {
  const ids = new Set<string>();
  for (const parent of parents) for (const id of [...parent.references, parent.id]) ids.add(id);
  return [...ids];
}

export function appendPost(dir: string, options: {
  body: string; name?: string; summary?: string; author?: string; replyTo?: string[];
  kind?: ThreadKind; supersedes?: string; map?: unknown;
  verifyTarget?: (thread: LocalThread, parents: string[], supersedes?: string) => void;
}): { post: ThreadPost; path: string } {
  const thread = loadThread(dir);
  if (thread.closed) throw new Error("Thread is closed; append to a new Thread rather than editing its history.");
  if (!options.body.trim()) throw new Error("Post body is required through --message or stdin.");
  if (Buffer.byteLength(options.body) > MAX_POST) throw new Error(`Post body exceeds ${MAX_POST} bytes.`);
  for (const value of [options.name, options.summary, options.author]) {
    if (value && (/[\r\n]/.test(value) || value.length > 1000)) throw new Error("Post header values must be single-line and at most 1,000 characters.");
  }
  const byId = new Map(thread.posts.map((post) => [post.id, post]));
  const referenced = new Set(thread.posts.flatMap((post) => post.inReplyTo));
  const tips = thread.posts.filter((post) => !referenced.has(post.id)).map((post) => post.id);
  // A closure joins all live tips by default; other posts follow the last post.
  // Callers can always choose explicit parents for a deliberate partial join.
  const parentIds = options.replyTo ?? (options.kind === "closure" ? tips : thread.posts.length ? [thread.posts.at(-1)!.id] : []);
  if (new Set(parentIds).size !== parentIds.length || parentIds.some((id) => !byId.has(id))) throw new Error("--reply-to must name distinct existing post ids in this Thread.");
  const parents = parentIds.map((id) => byId.get(id)!);
  if (options.kind === "correction" && (!options.supersedes || !byId.has(options.supersedes))) throw new Error("A correction requires --supersedes <existing post id>.");
  if (options.supersedes && options.kind !== "correction") throw new Error("--supersedes requires --kind correction.");
  if (options.map !== undefined) {
    const map = parseMap(options.map);
    if (map.status !== "valid") throw new Error("--map must contain a valid protocol Map block; no implicit HEAD pin is substituted.");
  }
  // Local-first exclusive create, not a cross-process lock: check the selected
  // target as late as possible before writing, after all option validation.
  options.verifyTarget?.(thread, parentIds, options.supersedes);
  const id = `msg_${randomUUID()}`;
  const date = new Date().toISOString();
  const stamp = date.replace(/[:.]/g, "-");
  const path = join(thread.path, `${stamp}-${id}.md`);
  const fields = {
    id, date, kind: options.kind ?? "post", ...(parentIds.length ? { in_reply_to: parentIds.length === 1 ? parentIds[0] : parentIds } : {}),
    ...(parents.length ? { references: references(parents) } : {}),
    ...(options.supersedes ? { supersedes: options.supersedes } : {}),
    ...(options.name ? { name: options.name } : {}), ...(options.summary ? { summary: options.summary } : {}),
    ...(options.author ? { author: options.author } : {}), ...(options.map !== undefined ? { map: options.map } : {}),
  };
  const content = `---\n${stringify(fields)}---\n\n${options.body.trim()}\n`;
  writeFileSync(path, content, { flag: "wx", mode: 0o600 });
  const parsed = parseThreadPost(content, basename(path));
  if (parsed.status !== "valid") throw new Error(`Generated post failed validation: ${parsed.issues.join(", ")}`);
  return { post: parsed.post, path };
}

function cursorPath(thread: LocalThread): string {
  const key = createHash("sha256").update(thread.path).digest("hex");
  return join(homedir(), ".ideaspaces", "cursors", `${key}.json`);
}

export function readCursor(thread: LocalThread): Set<string> {
  const path = cursorPath(thread);
  if (existsSync(dirname(path)) && lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Refusing symlink local cursor directory.");
  if (!existsSync(path)) return new Set();
  const data: unknown = JSON.parse(safeFile(path));
  if (!data || typeof data !== "object" || !Array.isArray((data as { seen?: unknown }).seen) ||
    !(data as { seen: unknown[] }).seen.every((id) => typeof id === "string")) throw new Error(`Invalid local Thread cursor: ${path}`);
  return new Set((data as { seen: string[] }).seen);
}

export function acknowledge(thread: LocalThread, posts: ThreadPost[]): void {
  const seen = readCursor(thread);
  for (const post of posts) seen.add(post.id);
  const path = cursorPath(thread);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("Refusing symlink local cursor directory.");
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ seen: [...seen] }), { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
}

/** Resolve only against the authored commit. Never use HEAD as a fallback. */
function readPinnedThreadFile(repo: string, pin: string, position: string): string {
  if (!SHA.test(pin)) throw new Error("A full 40-character authored commit pin is required.");
  const availability = gitAvailability();
  if (availability.state !== "usable") throw new Error(availability.hint);
  const read = readCheckoutAt(repo, pin, position, MAX_POST);
  if (read.status === "read") {
    if (read.kind !== "file") throw new Error(`${position} is a directory at pin ${pin}, not a post.`);
    return read.content;
  }
  if (read.status === "pin_absent" || read.status === "missing_path") {
    throw new Error(`Authored pin ${pin} does not contain ${position}; refusing working-tree HEAD fallback.`);
  }
  if (read.status === "too_large") throw new Error("Pinned post exceeds the read limit.");
  throw new Error(read.reason || "Pinned file could not be read.");
}

export function readPinnedThreadMember(repo: string, pin: string, position: string): string {
  if (!/^_threads\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.md$/.test(position) || position.includes("..")) throw new Error("Invalid _threads/ Map position.");
  return readPinnedThreadFile(repo, pin, position);
}

export function readPinnedThreadAgreement(repo: string, pin: string, position: string): string {
  if (!/^_threads\/[a-z0-9-]+\/_agent\/agreement\.md$/.test(position)) throw new Error("Invalid pinned Thread Agreement position.");
  return readPinnedThreadFile(repo, pin, position);
}

export function initWorktree(cwd = process.cwd()): string {
  const root = threadBase(cwd);
  const dir = join(root, "_threads");
  if (existsSync(dir)) throw new Error("_threads/ already exists; refusing to replace it.");
  const origin = git(root, ["rev-parse", "--show-toplevel"]);
  // Git prints forward slashes on Windows; the filesystem's realpath uses
  // native separators and may differ in drive-letter case. Canonicalize both
  // sides before deciding whether this Agreement is at the repo root.
  const canonical = (path: string) => {
    const value = realpathSync.native(path);
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  if (canonical(origin) !== canonical(root)) throw new Error("Run threads init at the repository root Agreement.");
  if (git(root, ["branch", "--list", "threads"])) throw new Error("Local threads branch already exists; refusing to replace it.");
  const ignore = join(root, ".gitignore");
  if (existsSync(ignore) && lstatSync(ignore).isSymbolicLink()) throw new Error("Refusing symlink .gitignore.");
  git(root, ["worktree", "add", "--orphan", "-b", "threads", dir]);
  markPrivateThreadsWorktree(dir);
  const old = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!old.split("\n").includes("/_threads/")) writeFileSync(ignore, `${old}${old && !old.endsWith("\n") ? "\n" : ""}/_threads/\n`);
  return dir;
}

export function pushWorktree(cwd = process.cwd(), remote?: string): string {
  const dir = safeDirectory(threadsDirectory(cwd));
  if (!remote || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(remote)) throw new Error("Pass --remote <team-remote> explicitly; never push private Threads to the default remote.");
  if (git(dir, ["branch", "--show-current"]) !== "threads") throw new Error("_threads/ must be the dedicated threads branch worktree.");
  const url = git(dir, ["remote", "get-url", "--push", remote]);
  if (remote === "origin") throw new Error("Refusing to push private Threads to origin; configure a separate team remote.");
  // A negative GitHub hostname check cannot recognize Enterprise installations
  // on arbitrary domains. Only the known team host (and local file remotes for
  // offline collaboration/tests) is allowed; never guess from a remote's name.
  const scp = /^[^@\s]+@([^:/\s]+):/.exec(url);
  const host = scp?.[1] ?? (url.includes("://") ? new URL(url).hostname : null);
  if (host !== "git.ideaspaces.xyz" && !(url.startsWith("file://") || isAbsolute(url))) {
    throw new Error("Private Threads may push only to git.ideaspaces.xyz or a local file remote; GitHub and unknown hosts are refused.");
  }
  git(dir, ["push", remote, "refs/heads/threads:refs/heads/threads"]);
  return remote;
}
