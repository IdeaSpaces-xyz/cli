/**
 * `threads new --from-note`: a Thread opened from a Note. The Note is committed (that one file), its
 * carried Map is pinned as a moment with the Note itself first, and the opening post is about the Note.
 * Everything that can refuse does so before anything is written, except the Note's own commit: words the
 * person wrote are never removed because the Thread could not be made.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { inspectFrontmatterSyntax, MAP_DEPTHS, parseCanonicalRepoUrl, parseFrontmatter, parseMap, parseThreadAttachment } from "@ideaspaces/protocol";
import { gitAvailability, gitBinary, sanitizedGitEnvironment } from "../git.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { loadMapCheckouts } from "./map-checkouts.js";
import { validateThreadMomentMap } from "./threads.js";

const MAX_NOTE = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const DEPTHS: ReadonlySet<string> = new Set(MAP_DEPTHS);
/** Stands in for the Note's commit while the opening Map is checked, before the commit is made. */
const PIN_TO_BE = "0".repeat(40);
/** The depth a member of the Note's Map gets when the Note names none. */
export const DEFAULT_MEMBER_DEPTH = "summary";

export interface NoteForThread {
  /** Absolute, canonical path of the Note. */
  path: string;
  /** Its position in its repository, forward slashes. */
  position: string;
  rootNodeId: string;
  /** The commit the opening Map pins the Note's repository at. */
  commit: string;
  /** Whether this call made that commit (false: the Note was already committed as it is). */
  committed: boolean;
  name: string;
  summary: string;
  /** `note:@<root_node_id>//<position>`, the opening post's `about`. */
  about: string;
  /** The opening Map, pinned: every root has a sha, every position member a depth. */
  map: { roots: Array<Record<string, unknown>>; members: Array<Record<string, unknown>> };
  /** How many members of the Note's own Map had no depth and got DEFAULT_MEMBER_DEPTH. */
  defaultedDepths: number;
}

function git(cwd: string, args: string[]) {
  return spawnSync(gitBinary(), args, { cwd, encoding: "utf8", env: sanitizedGitEnvironment(), timeout: 120_000 });
}

function gitText(cwd: string, args: string[]): string | null {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function failure(result: ReturnType<typeof git>): string {
  const text = (result.stderr || result.stdout || result.error?.message || "").trim();
  return (text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ") || `git exited ${result.status}`).slice(0, 400);
}

/** Where a Note may not sit: a post's place in a Thread, or an Agreement's folder. */
export function noteRefusal(position: string): string | null {
  const segments = position.split("/");
  if (segments.includes("_agent")) return "a Note for a Thread can't sit in an _agent/ folder, which holds an Agreement and its skills. Put it in Ideas/, or in a Thread's notes/ folder.";
  if (segments[0] === "_threads" || segments.includes("_threads")) {
    const at = segments.indexOf("_threads");
    if (segments.length - at === 3) return "every Markdown file directly in a Thread's folder is one of its posts. Put the Note in that Thread's notes/ folder.";
    if (segments[at + 2] !== "notes") return "inside a Thread, a Note goes in its notes/ folder.";
  }
  return null;
}

/**
 * Commit the one Note file and nothing else, as a post is committed: `git add` of that path, then a pathspec
 * commit, so what else is staged stays staged. On a failed commit the index is put back as it was.
 */
function commitNote(top: string, position: string, message: string): { commit: string; committed: boolean } {
  const status = git(top, ["status", "--porcelain", "--untracked-files=all", "--", position]);
  if (status.status !== 0) throw new Error(`Git couldn't read the Note's state: ${failure(status)}. Nothing created.`);
  const head = gitText(top, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!status.stdout.trim()) {
    if (!head) throw new Error("The Note's repository has no commits yet, and the Note isn't in Git. Nothing created.");
    return { commit: head, committed: false };
  }
  const tracked = git(top, ["ls-files", "--error-unmatch", "--", position]).status === 0;
  const retrying = (args: string[]) => {
    let result = git(top, args);
    for (let attempt = 0; attempt < 4 && result.status !== 0 && /index\.lock/.test(result.stderr ?? ""); attempt++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      result = git(top, args);
    }
    return result;
  };
  const added = retrying(["add", "--", position]);
  if (added.status !== 0) throw new Error(`The Note couldn't be added to Git: ${failure(added)}. Nothing created.`);
  const made = retrying(["commit", "-q", "-m", message, "--", position]);
  if (made.status !== 0) {
    // Back to what the index held: untracked stays untracked, a tracked Note keeps its last committed entry. A part
    // of the Note the person had staged by hand goes back to HEAD's; the file on disk is never touched.
    git(top, tracked ? ["reset", "-q", "--", position] : ["rm", "--cached", "-q", "--", position]);
    throw new Error(`The Note couldn't be committed, so the Thread's Map can't point at it as it is now: ${failure(made)}. The Note is on disk as you wrote it. Nothing created.`);
  }
  const commit = gitText(top, ["rev-parse", "HEAD"]);
  if (!commit || !SHA.test(commit)) throw new Error("The Note was committed, but Git didn't say at which commit. Nothing created; run the command again.");
  return { commit, committed: true };
}

function rootId(root: Record<string, unknown>): string | undefined {
  if (typeof root.root_node_id === "string") return root.root_node_id;
  if (typeof root.repo !== "string") return undefined;
  const parsed = parseCanonicalRepoUrl(root.repo);
  return parsed.status === "valid" ? parsed.rootNodeId : undefined;
}

/** A root the Note's Map names without a pin is pinned at its registered checkout's HEAD. */
function pinFromCheckout(id: string): string | null {
  const checkouts = loadMapCheckouts();
  for (const [path, registered] of Object.entries(checkouts)) {
    if (registered !== id || !existsSync(path)) continue;
    const sha = gitText(path, ["rev-parse", "HEAD"]);
    if (sha && SHA.test(sha)) return sha;
  }
  return null;
}

/**
 * Read the Note, commit it, and build the pinned opening Map. Refuses, naming what to fix, before any write
 * when the Note is missing, misplaced, malformed, or carries a Map that can't be pinned.
 */
export function prepareNoteForThread(input: string, cwd = process.cwd(), title?: string): NoteForThread {
  const requested = resolve(cwd, input);
  if (!existsSync(requested)) throw new Error(`--from-note names a Note that isn't there: ${requested}. Nothing created.`);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("--from-note must name a regular Markdown file, not a folder or a link. Nothing created.");
  if (!requested.endsWith(".md")) throw new Error("--from-note must name a Markdown Note (.md). Nothing created.");
  if (stat.size > MAX_NOTE) throw new Error("--from-note's Note is larger than 1 MiB. Nothing created.");
  const path = realpathSync.native(requested);

  const availability = gitAvailability();
  if (availability.state !== "usable") throw new Error(`${availability.hint} Nothing created.`);
  const topRaw = gitText(dirname(path), ["rev-parse", "--show-toplevel"]);
  if (!topRaw) throw new Error("The Note isn't in a Git repository, so the Thread's Map can't point at it. Nothing created.");
  const top = realpathSync.native(topRaw);
  const position = relative(top, path).split(sep).join("/");
  if (!position || position.startsWith("../") || isAbsolute(position)) throw new Error("The Note must be inside its repository. Nothing created.");
  const misplaced = noteRefusal(position);
  if (misplaced) throw new Error(`${position}: ${misplaced} Nothing created.`);

  const content = readFileSync(path, "utf8");
  const syntax = inspectFrontmatterSyntax(content);
  if (syntax.status === "malformed") throw new Error(`The Note's frontmatter can't be read: ${syntax.message}. Fix it, then try again. Nothing created.`);
  const frontmatter = parseFrontmatter(content) ?? {};
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : (title ?? "").trim();
  if (!name) throw new Error("The Note has no name in its frontmatter; give the Thread one with --about. Nothing created.");
  // The Thread's name is checked here, before the commit, when it is the Note's.
  if (title === undefined && (/[\r\n]/.test(name) || name.length > 200)) throw new Error("The Note's name is longer than one line of 200 characters, so it can't name the Thread; give the Thread one with --about. Nothing created.");
  // The summary heads the opening post, whose header values are one line of up to 1,000 characters; any other is left out.
  const rawSummary = typeof frontmatter.summary === "string" ? frontmatter.summary.trim() : "";
  const summary = /[\r\n]/.test(rawSummary) || rawSummary.length > 1000 ? "" : rawSummary;

  const identity = inspectLocalRootIdentity(top);
  const rootNodeId = identity.root_node_id;
  if (!rootNodeId) throw new Error(`The Note's repository (${top}) declares no root identity in its Agreement, so a Map can't name it. Nothing created.`);

  // The Note's own Map, if it carries one: checked now, pinned after the commit.
  let carried: { roots: Array<Record<string, unknown>>; members: Array<Record<string, unknown>> } = { roots: [], members: [] };
  if (frontmatter.map !== undefined) {
    const parsed = parseMap(frontmatter.map);
    if (parsed.status !== "valid") {
      const issues = parsed.status === "invalid" ? parsed.issues.map((issue) => `${issue.path} (${issue.code})`).join(", ") : "map is absent";
      throw new Error(`The Note's Map can't be read: ${issues}. Fix the named field, or take the map block out. Nothing created.`);
    }
    carried = JSON.parse(JSON.stringify(frontmatter.map)) as typeof carried;
    carried.roots ??= [];
    carried.members ??= [];
  }
  const roots = carried.roots.map((root) => ({ ...root }));
  let own = roots.findIndex((root) => rootId(root) === rootNodeId);
  if (own >= 0 && typeof roots[own]!.sha === "string" && roots[own]!.sha) {
    throw new Error(`The Note's Map pins its own repository at ${String(roots[own]!.sha).slice(0, 12)}. Take that root's sha out, so the Thread pins it together with the Note. Nothing created.`);
  }
  const pins = new Map<number, string>();
  for (const [index, root] of roots.entries()) {
    if (index === own || (typeof root.sha === "string" && SHA.test(root.sha))) continue;
    const id = rootId(root);
    const sha = id ? pinFromCheckout(id) : null;
    if (!sha) throw new Error(`The Note's Map names a repository (${id ?? (typeof root.name === "string" ? root.name : `root ${index}`)}) with no pin and no checkout on this machine to pin it at. Pin that root, or take its members out. Nothing created.`);
    pins.set(index, sha);
  }

  if (own < 0) { roots.push({ root_node_id: rootNodeId }); own = roots.length - 1; }
  for (const [index, sha] of pins) roots[index] = { ...roots[index], sha };

  const ownName = typeof roots[own]!.name === "string" ? roots[own]!.name : undefined;
  const isOwn = (member: Record<string, unknown>) => member.root === own || (ownName !== undefined && member.root === ownName);
  let defaultedDepths = 0;
  const members = carried.members.map((member) => {
    if (!("position" in member) || (typeof member.depth === "string" && DEPTHS.has(member.depth))) return { ...member };
    defaultedDepths++;
    return { ...member, depth: DEFAULT_MEMBER_DEPTH };
  });
  const self = members.findIndex((member) => "position" in member && member.position === position && isOwn(member));
  if (self < 0) {
    members.unshift({ root: own, position, depth: "full", name, ...(summary ? { summary } : {}) });
  } else if (self > 0) {
    // The Note is read first, at the depth its author chose.
    members.unshift(...members.splice(self, 1));
  }

  // Every check on what will be written runs before the commit: the Map with a stand-in for the Note's pin, and the link.
  const about = `note:@${rootNodeId}//${position}`;
  if (!parseThreadAttachment(about)) throw new Error(`The Note's address (${about}) isn't a link a Thread can be about. Nothing created.`);
  roots[own] = { ...roots[own], sha: PIN_TO_BE };
  validateThreadMomentMap({ roots, members });

  const { commit, committed } = commitNote(top, position, `Note for a Thread: ${name}`.slice(0, 200));
  roots[own] = { ...roots[own], sha: commit };
  const map = { roots, members };
  return { path, position, rootNodeId, commit, committed, name, summary, about, map, defaultedDepths };
}
