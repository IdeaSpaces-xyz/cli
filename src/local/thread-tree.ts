/**
 * The Thread tree of a Space as a Map: every `_threads/` under the start (the Space root and the
 * repositories inside it), each Thread by the state rule (protocol 0.33.0), parents resolved across
 * all of them, read at a rung, down to a level, as of a moment or since one, with the shape
 * problems named and defined by the command rather than by each reader's script.
 *
 * `ideaspaces map <start> --kind threads` is the one call UI/UX's 2026-11-14 tree audit took five
 * calls, 195 KB and a script to make. Read-only: nothing here writes.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildMap, dateFromFileName, entryInstant, resolveThreadParent as resolveProtocolParent,
  type MapBlock, type MapDepth, type ThreadAttachment, type TimeCursor,
} from "@ideaspaces/protocol";
import { gitBinary, sanitizedGitEnvironment } from "../git.js";
import { checkoutRootNodeId } from "./space-map.js";
import { mapOfRoots, mapStatusLine } from "./space-repos.js";
import { attachmentText, latestLocalActivity, listLocal, NoAgreementError, parseTimeCursor, threadOwner, type LocalThread } from "./threads.js";

/** Folders never entered while looking for repositories that hold Threads. */
const SKIPPED = new Set(["node_modules", ".git", "_threads", "_agent", "_assets", "_scratch", "dist", "bundle"]);
/** How deep below the start repositories are looked for: Home keeps them two levels down (agents/<x>). */
export const THREAD_ROOT_SEARCH_DEPTH = 2;
export const THREAD_ROOT_SEARCH_LIMIT = 2_000;

export const PROBLEM_CODES = ["open-under-closed", "extra-root", "parent-unresolved", "no-holder", "moved-title", "uncommitted"] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** One line each: what a reader may script against. */
export const PROBLEM_DEFINITIONS: Record<ProblemCode, string> = {
  "open-under-closed": "an open Thread whose current parent is a post in a closed Thread",
  "extra-root": "an open Thread with no parent other than the first such Thread in slug order, which is the root",
  "parent-unresolved": "a Thread whose parent names a post that is not found, is ambiguous, or cannot be read (an unreadable opening)",
  "no-holder": "an open Thread whose README names nobody (owner:, holder:, \"Held by X\", a Holder: line) and whose opening post has no author",
  "moved-title": "a Thread named by a reframe that only moved it: the title starts with \"Moved under\" or \"Reattached under\", or the body says it reattached the Thread (the titles the CLI's attach wrote before 0.33.0; a CLI reading, not the protocol's)",
  "uncommitted": "a Thread with files under _threads/<slug>/ that Git does not have committed (untracked, staged or modified)",
};

export type WhereFilter =
  | { kind: "open" } | { kind: "closed" } | { kind: "holder"; name: string } | { kind: "no-holder" } | { kind: "stale"; before: string };

export function parseWhere(value: string): WhereFilter {
  const trimmed = value.trim();
  if (trimmed === "open" || trimmed === "closed" || trimmed === "no-holder") return { kind: trimmed };
  const holder = /^holder:(.+)$/.exec(trimmed);
  if (holder && holder[1].trim()) return { kind: "holder", name: holder[1].trim() };
  const stale = /^stale:(\d{4}-\d{2}-\d{2}(?:T.*)?)$/.exec(trimmed);
  if (stale && !Number.isNaN(Date.parse(stale[1]))) return { kind: "stale", before: stale[1] };
  throw new Error(`--where must be open, closed, holder:<name>, no-holder or stale:<date>, not ${value}.`);
}

export interface ThreadTreeOptions {
  levels: number | "all";
  depth: MapDepth;
  where?: WhereFilter;
  problems: boolean;
  since?: string;
  asOf?: string;
}

export interface ThreadTreeRoot {
  /** Zero-based index, the Map root ordinal. */
  root: number;
  path: string;
  /** The folder's name under the start; the start itself is ".". */
  label: string;
  root_node_id: string | null;
  sha: string | null;
  threads: number;
  /** Files under _threads/ Git does not have committed, by status. */
  uncommitted: number;
  /** Why this root's Threads were not read, when they were not. */
  error?: string;
}

export interface ThreadTreeMember {
  root: number;
  position: string;
  slug: string;
  level: number;
  depth: MapDepth;
  name: string;
  name_source: LocalThread["nameSource"];
  closed: boolean | "unknown";
  parent: { id: string; slug: string; root: number } | null;
  parent_status: "resolved" | "none" | "unknown" | "unresolved" | "ambiguous";
  children: number;
  posts: number;
  newest_post_at: string | null;
  holder: string | null;
  uncommitted: string[];
  /** Posts after the `--since` cursor, when one was given. */
  new_posts?: number;
  summary?: string;
  about?: string[];
  current_map?: { post: string | null; members: number };
  child_slugs?: string[];
  newest?: Array<{ id: string; kind: string; date: string | null; name: string; author: string | null }>;
}

export interface ThreadProblem { code: ProblemCode; root: number; slug: string; detail: string }

export interface ThreadTree {
  schema: "ideaspaces.map.threads.v1";
  kind: "threads";
  start: string;
  levels: number | "all";
  depth: MapDepth;
  as_of?: string;
  since?: string;
  where?: string;
  roots: ThreadTreeRoot[];
  members: ThreadTreeMember[];
  problems: ThreadProblem[];
  definitions: Record<ProblemCode, string>;
  uncommitted: Array<{ root: number; slug: string; path: string; status: string }>;
  counts: { roots: number; threads: number; open: number; closed: number; listed: number; open_roots: number };
  /** The portable Map of the identified roots; null when none is identified and pinned. */
  map: MapBlock | null;
  /** available: every root is in the Map; partial: some stand outside it, named in `unidentified`; projection_pending: none could be. */
  map_status: "available" | "partial" | "projection_pending";
  unidentified: string[];
  warnings: string[];
  trimmed?: string;
  complete: boolean;
}

interface Loaded { root: ThreadTreeRoot; threads: LocalThread[]; byPath: Map<string, LocalThread> }

/** The start and every repository within THREAD_ROOT_SEARCH_DEPTH below it that holds a `_threads/`. A search that hits its cap says so. */
export function findThreadRoots(start: string, warnings: string[] = []): string[] {
  const found: string[] = [];
  const canonical = realpathSync(start);
  if (existsSync(join(canonical, "_threads"))) found.push(canonical);
  let visited = 0;
  let capped = false;
  const walk = (dir: string, level: number) => {
    if (level > THREAD_ROOT_SEARCH_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      if (name.startsWith(".") || SKIPPED.has(name)) continue;
      if (visited++ > THREAD_ROOT_SEARCH_LIMIT) { capped = true; return; }
      const child = join(dir, name);
      let isDirectory = false;
      try { isDirectory = lstatSync(child).isDirectory(); } catch { continue; }
      if (!isDirectory) continue;
      const repository = existsSync(join(child, ".git"));
      if (repository && existsSync(join(child, "_threads"))) found.push(child);
      // A repository's own repositories are its business, except that Home keeps repos in plain folders.
      if (!repository) walk(child, level + 1);
    }
  };
  walk(canonical, 1);
  if (capped) warnings.push(`the search for repositories holding _threads/ stopped at ${THREAD_ROOT_SEARCH_LIMIT} folders; some roots may be missing.`);
  return found;
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync(gitBinary(), args, { cwd, encoding: "utf8", env: sanitizedGitEnvironment({ GIT_OPTIONAL_LOCKS: "0" }), maxBuffer: 64 * 1024 * 1024, timeout: 8_000 });
  return result.status === 0 ? result.stdout : null;
}

/**
 * `git status --porcelain -z -- _threads` of one root: file → status, keyed by the path under the
 * root. Git names paths from the repository's top level, so a root that is a folder inside a larger
 * repository has its prefix stripped first.
 */
function uncommittedUnder(root: string): Map<string, string> {
  const out = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "_threads"]);
  const map = new Map<string, string>();
  if (out === null) return map;
  const prefix = git(root, ["rev-parse", "--show-prefix"])?.trim() ?? "";
  const entries = out.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const code = entry.slice(0, 2);
    let path = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++;
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
    if (!path.startsWith("_threads/")) continue;
    map.set(path, code.trim() || code);
  }
  return map;
}

function instantOf(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/** A `--since` or `--as-of` value as a moment: a date as given; an id or filename by the entry it names, found in any root. */
function cursorInstant(raw: string, loaded: Loaded[]): { cursor: TimeCursor; instant: number; found?: string } {
  const cursor = parseTimeCursor(raw);
  if ("at" in cursor) {
    const instant = instantOf(cursor.at);
    if (instant === undefined) throw new Error(`${raw} is not a date or instant.`);
    // A day-only cursor is the end of its day (time.md): as of a day includes everything written that day.
    return { cursor, instant: /^\d{4}-\d{2}-\d{2}$/.test(cursor.at) ? instant + 24 * 60 * 60 * 1000 - 1 : instant };
  }
  for (const { threads } of loaded) {
    for (const thread of threads) {
      const post = thread.allPosts.find((candidate) => "id" in cursor ? candidate.id === cursor.id : candidate.path === basename(cursor.path));
      if (post) {
        const instant = entryInstant({ ...post, path: `_threads/${thread.slug}/${post.path}` });
        if (instant === undefined) throw new Error(`${raw} names an entry with no date; it cannot be a moment.`);
        return { cursor, instant, found: `_threads/${thread.slug}/${post.path}` };
      }
    }
  }
  throw new Error(`${raw} names no entry in these Threads. Give an ISO date, an entry id, or an entry's filename.`);
}

function movedTitle(thread: LocalThread): boolean {
  if (thread.nameSource !== "reframe") return false;
  if (/^(Moved under|Reattached under) /.test(thread.name)) return true;
  const naming = [...thread.allPosts].reverse().find((post) => post.kind === "reframe" && typeof post.frontmatter.name === "string" && post.frontmatter.name.trim());
  return naming !== undefined && /^Reattached this Thread\./.test(naming.body.trim());
}

/**
 * Build the tree. Parents resolve through the protocol across every root's posts, so a Thread in
 * one repository may hang from a post in another; a parent that resolves nowhere is a problem,
 * never a guess.
 */
export function assembleThreadTree(start: string, options: ThreadTreeOptions): ThreadTree {
  const canonicalStart = realpathSync(start);
  const warnings: string[] = [];
  const searchWarnings: string[] = [];
  const rootPaths = findThreadRoots(canonicalStart, searchWarnings);
  if (!rootPaths.length) throw new Error(`No _threads/ under ${start}, in it or in a repository within ${THREAD_ROOT_SEARCH_DEPTH} levels of it.`);

  // Git is asked once per root; only the Thread reads repeat when --as-of names an entry that has to be found first.
  const readThreads = (path: string, label: string, root: ThreadTreeRoot, asOf?: TimeCursor): LocalThread[] => {
    let threads: LocalThread[] = [];
    try {
      threads = listLocal(path, (message) => warnings.push(`${label}: ${message}`), asOf ? { asOf } : {});
      // As of a moment before a Thread's first entry, the Thread did not exist: a folder with no entry then is not listed.
      if (asOf) threads = threads.filter((thread) => thread.allPosts.length > 0);
    } catch (error) {
      root.error = error instanceof NoAgreementError ? "no Space Agreement above its _threads/; its Threads were not read" : error instanceof Error ? error.message : String(error);
    }
    root.threads = threads.length;
    return threads;
  };
  const loadAll = (asOf?: TimeCursor): Array<Loaded & { uncommitted: Map<string, string> }> => rootPaths.map((path, index) => {
    // The label is a Map-address name and a portable position: forward slashes on every platform.
    const label = path === canonicalStart ? "." : relative(canonicalStart, path).split("\\").join("/");
    const uncommitted = uncommittedUnder(path);
    const root: ThreadTreeRoot = { root: index, path, label, root_node_id: checkoutRootNodeId(path), sha: git(path, ["rev-parse", "--verify", "--quiet", "HEAD"])?.trim() ?? null, threads: 0, uncommitted: uncommitted.size };
    const threads = readThreads(path, label, root, asOf);
    return { root, threads, byPath: new Map(threads.map((thread) => [`_threads/${thread.slug}`, thread])), uncommitted };
  });
  let loaded = loadAll();

  let asOf: { cursor: TimeCursor; instant: number } | undefined;
  if (options.asOf) {
    asOf = cursorInstant(options.asOf, loaded);
    warnings.length = 0;
    const at: TimeCursor = { at: new Date(asOf.instant).toISOString() };
    loaded = loaded.map(({ root, uncommitted }) => {
      root.error = undefined;
      const threads = readThreads(root.path, root.label, root, at);
      return { root, threads, byPath: new Map(threads.map((thread) => [`_threads/${thread.slug}`, thread])), uncommitted };
    });
  }
  warnings.push(...searchWarnings);
  const since = options.since ? cursorInstant(options.since, loaded) : undefined;

  // Every post of every root, for the protocol's resolver; the root's label is its Map-address name.
  const protocolRoots = loaded.map(({ root, threads }) => ({
    root: root.label, pin: "working-tree",
    posts: threads.flatMap((thread) => thread.allPosts.map((post) => ({ path: `_threads/${thread.slug}/${post.path}`, id: post.id }))),
  }));
  const rootIndexByLabel = new Map(loaded.map(({ root }) => [root.label, root.root]));

  interface Node { root: number; thread: LocalThread; parent: ThreadTreeMember["parent"]; status: ThreadTreeMember["parent_status"]; children: Node[]; level: number }
  const nodes: Node[] = [];
  const byKey = new Map<string, Node>();
  for (const { root, threads } of loaded) {
    for (const thread of threads) {
      const attachment: ThreadAttachment | "unknown" | null = thread.attachment;
      let parent: ThreadTreeMember["parent"] = null;
      let status: ThreadTreeMember["parent_status"] = "none";
      if (attachment === "unknown") status = "unknown";
      else if (attachment !== null) {
        const resolved = resolveProtocolParent(attachment, protocolRoots);
        if (resolved.status === "resolved") {
          const parentRoot = rootIndexByLabel.get(resolved.parent.root) ?? root.root;
          parent = { id: resolved.parent.id, slug: resolved.parent.path.split("/")[1], root: parentRoot };
          status = "resolved";
        } else status = resolved.status === "none" ? "none" : resolved.status;
      }
      const node: Node = { root: root.root, thread, parent, status, children: [], level: 0 };
      nodes.push(node);
      byKey.set(`${root.root}:${thread.slug}`, node);
    }
  }
  const roots: Node[] = [];
  for (const node of nodes) {
    const parentNode = node.parent ? byKey.get(`${node.parent.root}:${node.parent.slug}`) : undefined;
    if (parentNode && parentNode !== node) parentNode.children.push(node);
    else roots.push(node);
  }
  const bySlug = (a: Node, b: Node) => a.thread.slug < b.thread.slug ? -1 : a.thread.slug > b.thread.slug ? 1 : 0;
  // Depth-first, siblings by slug; a cycle (a parent below its own child) is cut where it closes.
  const ordered: Node[] = [];
  const placed = new Set<Node>();
  const visit = (node: Node, level: number, trail: Set<Node>) => {
    if (trail.has(node) || placed.has(node)) { if (trail.has(node)) warnings.push(`${node.thread.slug}: its parent chain closes a cycle; listed once.`); return; }
    node.level = level;
    ordered.push(node);
    placed.add(node);
    const next = new Set(trail); next.add(node);
    for (const child of [...node.children].sort(bySlug)) visit(child, level + 1, next);
  };
  for (const node of [...roots].sort(bySlug)) visit(node, 1, new Set());
  // A Thread reachable only through a cycle never reached a root: list it at level 1 so nothing is hidden.
  for (const node of nodes.sort(bySlug)) if (!placed.has(node)) { warnings.push(`${node.thread.slug}: reachable only through a cycle; listed at level 1.`); visit(node, 1, new Set()); }

  // Problems, over the whole tree before any filter: a filter changes what is listed, not what is wrong.
  const problems: ThreadProblem[] = [];
  const openRoots = roots.filter((node) => node.thread.closed !== true && node.status === "none").sort(bySlug);
  for (const node of nodes) {
    const t = node.thread;
    const parentNode = node.parent ? byKey.get(`${node.parent.root}:${node.parent.slug}`) : undefined;
    if (t.closed !== true && parentNode && parentNode.thread.closed === true) problems.push({ code: "open-under-closed", root: node.root, slug: t.slug, detail: `open under ${parentNode.thread.slug}, which is closed` });
    if (node.status === "unknown" || node.status === "unresolved" || node.status === "ambiguous") problems.push({ code: "parent-unresolved", root: node.root, slug: t.slug, detail: `parent ${t.attachment && t.attachment !== "unknown" ? attachmentText(t.attachment) : "unknown"} is ${node.status}` });
    if (t.closed !== true && threadOwner(t).owner === null) problems.push({ code: "no-holder", root: node.root, slug: t.slug, detail: "no holder in the README and no author on the opening post" });
    if (movedTitle(t)) problems.push({ code: "moved-title", root: node.root, slug: t.slug, detail: `named "${t.name}" by a reframe that only moved it` });
  }
  for (const node of openRoots.slice(1)) problems.push({ code: "extra-root", root: node.root, slug: node.thread.slug, detail: `open with no parent; the root is ${openRoots[0].thread.slug}` });
  const uncommitted: ThreadTree["uncommitted"] = [];
  const uncommittedBySlug = new Map<string, string[]>();
  for (const { root, uncommitted: files } of loaded) {
    for (const [path, status] of files) {
      const slug = path.split("/")[1];
      if (!slug) continue;
      uncommitted.push({ root: root.root, slug, path, status });
      const key = `${root.root}:${slug}`;
      uncommittedBySlug.set(key, [...(uncommittedBySlug.get(key) ?? []), path.split("/").slice(2).join("/")]);
    }
  }
  for (const [key, files] of uncommittedBySlug) {
    const [root, slug] = key.split(":");
    problems.push({ code: "uncommitted", root: Number(root), slug, detail: `${files.length} file${files.length === 1 ? "" : "s"} not committed: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}` });
  }
  problems.sort((a, b) => PROBLEM_CODES.indexOf(a.code) - PROBLEM_CODES.indexOf(b.code) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // The members: by level, then by filter, then by since.
  const members: ThreadTreeMember[] = [];
  for (const node of ordered) {
    if (options.levels !== "all" && node.level > options.levels) continue;
    const t = node.thread;
    const holder = threadOwner(t).owner;
    const newest = latestLocalActivity(t.posts);
    if (options.where) {
      const w = options.where;
      if (w.kind === "open" && t.closed === true) continue;
      if (w.kind === "closed" && t.closed !== true) continue;
      if (w.kind === "holder" && (holder ?? "").toLowerCase() !== w.name.toLowerCase()) continue;
      if (w.kind === "no-holder" && holder !== null) continue;
      if (w.kind === "stale" && !(t.closed !== true && (newest === null || Date.parse(newest) < Date.parse(w.before)))) continue;
    }
    let newPosts: number | undefined;
    if (since) {
      newPosts = t.allPosts.filter((post) => { const at = entryInstant({ ...post, path: `_threads/${t.slug}/${post.path}` }); return at !== undefined && at > since.instant; }).length;
      if (newPosts === 0) continue;
    }
    const member: ThreadTreeMember = {
      root: node.root, position: `_threads/${t.slug}`, slug: t.slug, level: node.level, depth: options.depth,
      name: t.name, name_source: t.nameSource, closed: t.closed, parent: node.parent, parent_status: node.status,
      children: node.children.length, posts: t.allPosts.length, newest_post_at: newest, holder,
      uncommitted: uncommittedBySlug.get(`${node.root}:${t.slug}`) ?? [],
      ...(newPosts !== undefined ? { new_posts: newPosts } : {}),
    };
    if (options.depth !== "name") {
      member.summary = t.summary;
      member.about = t.about.map(attachmentText);
      member.current_map = { post: t.currentMap.post?.id ?? null, members: t.currentMap.map?.members.length ?? 0 };
    }
    if (options.depth === "children" || options.depth === "surface" || options.depth === "full") {
      member.child_slugs = [...node.children].sort(bySlug).map((child) => child.thread.slug);
    }
    if (options.depth === "surface" || options.depth === "full") {
      member.newest = t.posts.slice(-5).reverse().map((post) => ({ id: post.id, kind: post.kind, date: post.date ?? null, name: post.frontmatter.name ?? post.id, author: post.frontmatter.author ?? null }));
    }
    members.push(member);
  }

  // The Map carries the identified roots; the Threads of an unidentified root stay members of the answer and
  // their root is named beside the Map, as such (buildMap takes no root without identity).
  const { map: rootsMap, map_status, unidentified, mapIndex } = mapOfRoots(loaded.map(({ root }) => root), canonicalStart, []);
  const built = rootsMap ? buildMap({
    roots: rootsMap.roots,
    members: members.filter((member) => mapIndex.has(member.root)).map((member) => ({ root: mapIndex.get(member.root)!, position: member.position, depth: member.depth, ...(member.summary ? { summary: member.summary } : {}) })),
  }) : null;
  const map = built?.status === "valid" ? built.map : null;
  const total = nodes.length;
  const trimmed = options.depth === "surface" || options.depth === "full"
    ? "surface and full show each Thread's five newest posts as lines; bodies are read with `ideaspaces look _threads/<slug> --post <id>` or `threads open`."
    : undefined;
  return {
    schema: "ideaspaces.map.threads.v1", kind: "threads", start: canonicalStart, levels: options.levels, depth: options.depth,
    ...(asOf ? { as_of: options.asOf } : {}), ...(since ? { since: options.since } : {}), ...(options.where ? { where: whereText(options.where) } : {}),
    roots: loaded.map(({ root }) => root), members, problems: options.problems ? problems : [], definitions: PROBLEM_DEFINITIONS, uncommitted,
    counts: { roots: loaded.length, threads: total, open: nodes.filter((node) => node.thread.closed !== true).length, closed: nodes.filter((node) => node.thread.closed === true).length, listed: members.length, open_roots: openRoots.length },
    map, map_status, unidentified, warnings, ...(trimmed ? { trimmed } : {}),
    complete: loaded.every(({ root }) => !root.error) && warnings.length === 0 && searchWarnings.length === 0,
  };
}

export function whereText(where: WhereFilter): string {
  return where.kind === "holder" ? `holder:${where.name}` : where.kind === "stale" ? `stale:${where.before}` : where.kind;
}

/** The tree as text: one line per Thread, indented by level, about 70 bytes each at the name rung. */
export function renderThreadTree(tree: ThreadTree): string {
  const lines: string[] = [];
  const scope = [tree.as_of ? `as of ${tree.as_of}` : "", tree.since ? `since ${tree.since}` : "", tree.where ? `where ${tree.where}` : ""].filter(Boolean).join(", ");
  lines.push(`Thread tree — ${tree.start} (${tree.counts.roots} root${tree.counts.roots === 1 ? "" : "s"}, ${tree.counts.threads} Threads, ${tree.counts.open} open; ${tree.counts.listed} listed at ${tree.depth}, levels ${tree.levels}${scope ? `; ${scope}` : ""})`);
  for (const root of tree.roots) {
    lines.push(`[${root.root}] ${root.label}${root.root_node_id ? ` — ${root.root_node_id}` : ""}${root.sha ? ` @ ${root.sha.slice(0, 12)}` : " (no HEAD)"} — ${root.threads} Threads${root.uncommitted ? `, ${root.uncommitted} uncommitted file${root.uncommitted === 1 ? "" : "s"} under _threads/` : ""}${root.error ? ` — not read: ${root.error}` : ""}`);
  }
  if (tree.members.length) lines.push("");
  const flat = Boolean(tree.where || tree.since);
  // The name rung is a line a reader scans: the slug, a clipped name, the state, and only what differs from the default.
  const clip = (text: string, max: number) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
  const where = (root: number) => (root ? ` [${root}]` : "");
  for (const member of tree.members) {
    const indent = flat ? "" : "  ".repeat(member.level - 1);
    const state = member.closed === "unknown" ? "closed: unknown" : member.closed ? "closed" : "open";
    const parent = flat && member.parent ? ` ← ${member.parent.slug}` : member.parent_status !== "resolved" && member.parent_status !== "none" ? ` ← parent ${member.parent_status}` : "";
    const head = `${indent}${member.slug}  ${clip(member.name, tree.depth === "name" ? 60 : 120)} · ${state}${member.children ? ` · ${member.children} children` : ""}${member.newest_post_at ? ` · ${member.newest_post_at.slice(0, 10)}` : ""}${member.new_posts !== undefined ? ` · ${member.new_posts} new` : ""}${member.uncommitted.length ? ` · ${member.uncommitted.length} uncommitted` : ""}${where(member.root)}${parent}`;
    lines.push(head);
    if (member.summary !== undefined) lines.push(`${indent}  ${clip(member.summary, 200)}${member.holder ? ` · holder: ${member.holder}` : ""}${member.about?.length ? ` · about: ${member.about.join(", ")}` : ""}${member.current_map ? ` · Map: ${member.current_map.post ? `${member.current_map.members} members` : "none"}` : ""}`);
    if (member.child_slugs?.length && flat) lines.push(`${indent}  children: ${member.child_slugs.join(", ")}`);
    for (const post of member.newest ?? []) lines.push(`${indent}    ${post.date?.slice(0, 10) ?? "undated"} ${post.id} (${post.kind}${post.author ? `, ${post.author}` : ""}) — ${clip(post.name, 120)}`);
  }
  if (tree.problems.length) {
    lines.push("", `Problems (${tree.problems.length}):`);
    for (const code of PROBLEM_CODES) {
      const of = tree.problems.filter((problem) => problem.code === code);
      if (!of.length) continue;
      lines.push(`  ${code} (${of.length}): ${PROBLEM_DEFINITIONS[code]}`);
      // One entry per Thread, the detail only where it says more than the slug does.
      const entries = of.map((problem) => {
        const slug = `${problem.slug}${where(problem.root)}`;
        if (code === "open-under-closed") return `${slug} ← ${problem.detail.replace(/^open under (\S+), which is closed$/, "$1")}`;
        if (code === "uncommitted") return `${slug} (${problem.detail.replace(/^(\d+) file.*$/, "$1")})`;
        if (code === "parent-unresolved") return `${slug}: ${problem.detail}`;
        return slug;
      });
      lines.push(`    ${entries.join(", ")}`);
    }
  }
  if (tree.warnings.length) lines.push("", `Warnings (${tree.warnings.length}):`, ...tree.warnings.map((warning) => `  ${warning}`));
  if (tree.trimmed) lines.push("", `Trimmed: ${tree.trimmed}`);
  lines.push("", `Map: ${mapStatusLine(tree.map_status, tree.unidentified, "roots")}`);
  return lines.join("\n");
}
