import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { parseFrontmatter, parseThreadPost, type MapPositionMember, type MapRoot, type ThreadPost } from "@ideaspaces/protocol";
import { listClones } from "../auth/spaces.js";
import { sanitizedGitEnvironment } from "../git.js";
import { inspectLocalRootIdentity } from "../root-identity.js";
import { loadThread, readPinnedThreadAgreement, readPinnedThreadMember, resolveLocalThread, threadBase, type LocalThread } from "./threads.js";

const ROOT_IN_URL = /\/repos\/(n_[0-9a-f]{12}(?:[0-9a-f]{12})?)(?:\/|$)/;

function physical(path: string): string {
  if (!isAbsolute(path) || !existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) {
    throw new Error(`Local checkout must be an existing non-symlink absolute directory: ${path}`);
  }
  return realpathSync.native(path);
}

function rootId(root: MapRoot): string {
  const id = root.root_node_id ?? ROOT_IN_URL.exec(root.repo ?? "")?.[1];
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
  const matches = listClones().filter(({ record }) => record.root_node_id === id);
  const paths = new Set(matches.map(({ path }) => physical(path)));
  if (hint) {
    const selected = physical(hint);
    // An explicit physical choice is required when there are several registered copies.
    // An unregistered checkout is also allowed, but must prove the same root identity.
    return validatedCheckout(selected, id);
  }
  if (paths.size === 0) {
    // Same-Space Map reads have always worked without a registry entry. This
    // does not discover another checkout: it is only the caller's own Space.
    const caller = threadBase();
    if (inspectLocalRootIdentity(caller).root_node_id === id) return validatedCheckout(caller, id);
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
  /** Recheck the selected bytes, Thread identity and explicit parents immediately before a write. */
  verifyWrite: (live: LocalThread, parents: string[]) => void;
}

export function selectLocalThreadTarget(input: string, root: MapRoot, member: MapPositionMember, checkoutHint?: string): SelectedThreadTarget {
  const checkout = locate(root, checkoutHint);
  const commit = spawnSync("git", ["cat-file", "-t", root.sha], {
    cwd: checkout, encoding: "utf8", env: sanitizedGitEnvironment(),
  });
  if (commit.status !== 0 || commit.stdout.trim() !== "commit") throw new Error("Selected authored pin is not a commit in this checkout.");
  const position = member.position;
  const match = /^_threads\/([a-z0-9][a-z0-9-]{0,100})\/([^/]+\.md)$/.exec(position);
  if (!match || match[2] === "README.md" || match[2].includes("..") || member.depth === "name") {
    throw new Error("Selected Map member must name a pinned Thread post, not a README or another position.");
  }
  const slug = match[1];
  // The positional operand is a slug, not a cross-Space path grant. A checkout
  // hint selects the Space root; the authored member selects only its Thread.
  if (input !== slug) throw new Error(`Selected Map member belongs to Thread ${slug}; pass that slug, not a path.`);
  const directory = resolveLocalThread(slug, checkout);
  const thread = loadThread(directory);
  const pinned = readPinnedThreadMember(checkout, root.sha, position);
  const parsed = parseThreadPost(pinned, basename(position));
  if (parsed.status !== "valid") throw new Error("Selected authored Thread post is invalid.");
  const prefix = `_threads/${slug}/`;
  const agreement = readPinnedThreadAgreement(checkout, root.sha, `${prefix}_agent/agreement.md`);
  const readme = readPinnedThreadMember(checkout, root.sha, `${prefix}README.md`);
  if (!parseFrontmatter(agreement) || !parseFrontmatter(readme)) throw new Error("Pinned Thread Agreement or README is invalid.");
  const verifyWrite = (live: LocalThread, parents: string[]) => {
    if (live.path !== directory || live.slug !== slug || live.closed) throw new Error("Selected live Thread changed or closed; refusing append.");
    const selectedPath = join(directory, basename(position));
    const safeEqual = (path: string, content: string) => existsSync(path) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isFile() && readFileSync(path, "utf8") === content;
    if (!safeEqual(join(directory, "_agent", "agreement.md"), agreement) ||
        !safeEqual(join(directory, "README.md"), readme) ||
        !safeEqual(selectedPath, pinned) || !live.posts.some((post) => post.id === parsed.post.id && post.path === basename(position))) {
      throw new Error("Selected live Thread differs from the authored pin; refusing append.");
    }
    if (!parents.length || new Set(parents).size !== parents.length) throw new Error("Selected cross-Space post requires distinct explicit --reply-to ids; no implicit HEAD parent.");
    for (const id of parents) {
      const parent: ThreadPost | undefined = live.posts.find((post) => post.id === id);
      if (!parent || !safeEqual(join(directory, parent.path), readPinnedThreadMember(checkout, root.sha, `${prefix}${parent.path}`))) {
        throw new Error(`Selected parent ${id} is missing or changed since the authored pin.`);
      }
    }
  };
  return { checkout, thread, pin: root.sha, position, pinned, verifyWrite };
}
