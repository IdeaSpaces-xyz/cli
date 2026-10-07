import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { parseCanonicalRepoUrl, parseFrontmatter, parseThreadPost, type MapPositionMember, type MapRoot, type ThreadPost } from "@ideaspaces/protocol";
import { listClones } from "../auth/spaces.js";
import { sanitizedGitEnvironment } from "../git.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { loadThread, readPinnedThreadAgreement, readPinnedThreadMember, resolveLocalThread, threadBase, type LocalThread } from "./threads.js";

function physical(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Local checkout must be an existing non-symlink absolute directory: ${path}`);
  try {
    const entry = lstatSync(path);
    if (!entry.isSymbolicLink() && entry.isDirectory()) return realpathSync.native(path);
  } catch { /* Missing or inaccessible is a refusal, not a locator fallback. */ }
  throw new Error(`Local checkout must be an existing non-symlink absolute directory: ${path}`);
}

function rootId(root: MapRoot): string {
  const parsed = root.repo ? parseCanonicalRepoUrl(root.repo) : null;
  const id = root.root_node_id ?? (parsed?.status === "valid" ? parsed.rootNodeId : undefined);
  if (!id) throw new Error("Selected Map root needs a portable root identity.");
  return id;
}

function validatedCheckout(path: string, expected: string): string {
  const checkout = physical(path);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: checkout, encoding: "utf8", env: sanitizedGitEnvironment(),
  });
  if (result.status !== 0 || physical(result.stdout.trim()) !== checkout) {
    throw new Error("Selected checkout must be the repository root, not a nested directory or worktree.");
  }
  const report = inspectLocalRootIdentity(checkout);
  if (report.declaration.dirty || !report.root_node_id || report.root_node_id !== expected) {
    throw new Error(`Selected checkout root identity is missing, mismatched or drifted from Map root ${expected}.`);
  }
  return checkout;
}

/** Registry narrows discovery, not authority. A hint selects among physical copies or an unregistered Home. */
function locate(root: MapRoot, hint?: string): string {
  const id = rootId(root);
  if (hint) {
    // A stale registry path must not prevent a different explicit physical
    // choice. validatedCheckout reconciles the hint's own identity evidence.
    return validatedCheckout(hint, id);
  }
  const matches = listClones().filter(({ record }) => record.root_node_id === id);
  const paths = new Set(matches.map(({ path }) => physical(path)));
  if (paths.size === 0) {
    // Same-Space Map reads have always worked without a registry entry. This
    // does not discover another checkout: it is only the caller's own Space.
    const caller = threadBase();
    const callerId = inspectLocalRootIdentity(caller).root_node_id;
    if (callerId === id) return validatedCheckout(caller, id);
    if (callerId === null) throw new Error(`Map root ${id} has no registered checkout and the caller has no verifiable root identity. Pass --checkout <absolute Space root> for another Space; for this Space, declare root_node_id in its Agreement (check with ideaspaces doctor).`);
  }
  if (paths.size !== 1) throw new Error(`Map root ${id} has ${paths.size} registered local checkouts; pass --checkout <absolute Space root> for an explicit validated choice.`);
  return validatedCheckout([...paths][0], id);
}

export interface SelectedThreadTarget {
  checkout: string;
  thread: LocalThread;
  pin: string;
  position: string;
  pinned: string;
  post: ThreadPost;
  name: string;
  summary: string;
  /** Recheck the selected bytes, Thread identity and explicit parents immediately before a write. */
  verifyWrite: (live: LocalThread, parents: string[], supersedes?: string) => void;
}

export function selectLocalThreadTarget(input: string, root: MapRoot, member: MapPositionMember, checkoutHint?: string): SelectedThreadTarget {
  const pin = root.sha;
  if (!pin || !/^[0-9a-f]{40}$/.test(pin)) throw new Error("Selected authored pin must be a full 40-character commit SHA.");
  if (!member.depth) throw new Error("Selected authored Thread member needs a depth ceiling.");
  const checkout = locate(root, checkoutHint);
  const commit = spawnSync("git", ["cat-file", "-t", pin], {
    cwd: checkout, encoding: "utf8", env: sanitizedGitEnvironment(),
  });
  if (commit.status !== 0 || commit.stdout.trim() !== "commit") throw new Error("Selected authored pin is not a commit in this checkout.");
  const position = member.position;
  const match = /^_threads\/([a-z0-9][a-z0-9-]{0,100})\/([^/]+\.md)$/.exec(position);
  if (!match || match[2] === "README.md" || match[2].includes("..") || member.depth === "name") {
    throw new Error("Selected Map member must name a pinned Thread post, not a README or another position.");
  }
  const slug = match[1];
  const directory = resolveLocalThread(slug, checkout);
  // Preserve same-Space paths, but never let a path locate a cross-Space
  // target. Only the hint chooses the checkout; the member chooses its slug.
  if (input !== slug && (threadBase() !== checkout || resolveLocalThread(input) !== directory)) {
    throw new Error(`Selected Map member belongs to Thread ${slug}; pass that slug, not a cross-Space path.`);
  }
  const thread = loadThread(directory);
  const pinned = readPinnedThreadMember(checkout, pin, position);
  const parsed = parseThreadPost(pinned, basename(position));
  if (parsed.status !== "valid") throw new Error("Selected authored Thread post is invalid.");
  const prefix = `_threads/${slug}/`;
  const agreement = readPinnedThreadAgreement(checkout, pin, `${prefix}_agent/agreement.md`);
  const readme = readPinnedThreadMember(checkout, pin, `${prefix}README.md`);
  const frontmatter = parseFrontmatter(readme);
  if (!parseFrontmatter(agreement) || !frontmatter) throw new Error("Pinned Thread Agreement or README is invalid.");
  const name = typeof frontmatter.name === "string" ? frontmatter.name : slug;
  const summary = typeof frontmatter.summary === "string" ? frontmatter.summary : "";
  const verifyWrite = (live: LocalThread, parents: string[], supersedes?: string) => {
    if (live.path !== directory || live.slug !== slug || live.closed) throw new Error("Selected live Thread changed or closed; refusing append.");
    const selectedPath = join(directory, basename(position));
    const safeEqual = (path: string, content: string) => {
      if (!existsSync(path)) return false;
      const entry = lstatSync(path);
      return !entry.isSymbolicLink() && entry.isFile() && readFileSync(path, "utf8") === content;
    };
    if (!safeEqual(join(directory, "_agent", "agreement.md"), agreement) ||
        !safeEqual(join(directory, "README.md"), readme) ||
        !safeEqual(selectedPath, pinned) || !live.posts.some((post) => post.id === parsed.post.id && post.path === basename(position))) {
      throw new Error("Selected live Thread differs from the authored pin; re-author the Map at the updated Thread commit before appending.");
    }
    if (!parents.length || new Set(parents).size !== parents.length) throw new Error("Selected cross-Space post requires distinct explicit --reply-to ids; no implicit HEAD parent.");
    for (const id of [...parents, ...(supersedes ? [supersedes] : [])]) {
      const parent: ThreadPost | undefined = live.posts.find((post) => post.id === id);
      if (!parent || !safeEqual(join(directory, parent.path), readPinnedThreadMember(checkout, pin, `${prefix}${parent.path}`))) {
        throw new Error(`Selected parent or superseded post ${id} is missing or changed since the authored pin.`);
      }
    }
  };
  return { checkout, thread, pin, position, pinned, post: parsed.post, name, summary, verifyWrite };
}
