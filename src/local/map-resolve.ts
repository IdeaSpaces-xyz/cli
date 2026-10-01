import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import {
  formatMapPositionAddress,
  inspectFrontmatterSyntax,
  isMapRootName,
  parseFrontmatter,
  resolveMapPositionAddress,
  resolveThreadGitPath,
  type MapBlock,
  type MapRoot,
} from "@ideaspaces/protocol";
import { isHostedSpaceRecord, loadSpaces, type SpacesMap } from "../auth/spaces.js";
import { gitAvailability, repoRoot, sanitizedGitEnvironment } from "../git.js";
import type { LoadedMapNote } from "./map-note.js";
import { CHECKOUT_SEARCH_LIMIT, checkoutRootNodeId, inspectSpaceMapRoots, type SpaceMapRootDrift } from "./space-map.js";

/** Which commit a member is read at: the root's pin, or its checkout's HEAD. */
export type MapReadAt = "pin" | "head";

/**
 * A Space's Map orients: its pins record when the curator last looked, so it reads HEAD and
 * flags drift. A Thread's Map was frozen when sent, so it reads the pin.
 */
export type MapKind = "space" | "thread";

/**
 * Where a read came from, or why there are no bytes.
 *
 * - `checkout_at_pin` / `checkout_at_head` — read from a local checkout at that commit;
 * - `pin_absent` — a checkout exists but does not hold the pinned commit (shallow, rewritten, not fetched);
 * - `missing_path` — the commit holds no such position;
 * - `too_large` — the file exceeds the read limit;
 * - `unreachable` — the root is in the Map but cannot be read here. `checkoutPath` tells the two
 *   causes apart: null when no checkout was found, set when one was found but Git failed on it;
 * - `invalid_address` — the address does not parse or names no single root of this Map.
 */
export type MapReadStatus =
  | "checkout_at_pin"
  | "checkout_at_head"
  | "pin_absent"
  | "missing_path"
  | "too_large"
  | "unreachable"
  | "invalid_address";

export interface MapTreeEntry {
  name: string;
  type: "file" | "directory";
}

export interface MapReadResult {
  status: MapReadStatus;
  /** The address as given; absent when a caller read a located root directly. */
  address?: string;
  /** The identity form of the address, when the root and its identity are known. */
  canonical?: string;
  rootIndex?: number;
  root?: MapRoot;
  position?: string;
  at: MapReadAt;
  pinnedSha?: string;
  headSha?: string | null;
  /** The root's checkout HEAD differs from its pin. Reported at either `at`. */
  drift: boolean;
  checkoutPath?: string | null;
  /** The commit the bytes came from. */
  commit?: string;
  kind?: "file" | "directory";
  /** File content, UTF-8. */
  content?: string;
  /** Directory entries, in Git tree order. */
  entries?: MapTreeEntry[];
  /** Why there are no bytes, in words for a person. */
  reason?: string;
}

export interface MapResolveOptions {
  /** Read at the pin or HEAD. Defaults from `kind`. */
  at?: MapReadAt;
  /** Defaults to `thread` for a Map under `_threads/`, else `space`. */
  kind?: MapKind;
  /**
   * Where checkouts are looked for (the folder itself, folders below it, then the registry).
   * Defaults to the Map note's folder, else the working directory.
   */
  contextDir?: string;
  /** The reader's own root identity for `//…`. Defaults to the identity of the working directory's checkout. */
  self?: string;
  /** File read limit in bytes. */
  maxBytes?: number;
}

export const MAP_READ_MAX_BYTES = 1024 * 1024;

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isLoadedMapNote(value: LoadedMapNote | MapBlock): value is LoadedMapNote {
  return typeof (value as LoadedMapNote).path === "string" && typeof (value as LoadedMapNote).map === "object";
}

/** The kind of a Map by where its note lives: anything under `_threads/` is a Thread's. */
export function mapKindOf(notePath: string | undefined): MapKind {
  return notePath && notePath.split(/[\\/]/).includes("_threads") ? "thread" : "space";
}

export function defaultReadAt(kind: MapKind): MapReadAt {
  return kind === "thread" ? "pin" : "head";
}

/**
 * Read one member of a Map by address — `@n_…//pos`, `@name//pos`, or `//pos`.
 *
 * Finds the root's checkout by identity (never by the folder it happens to be in), reads at the
 * pin or HEAD, and says where the bytes came from and whether the root has drifted. Every outcome
 * is a result; nothing here throws for a root that cannot be reached.
 */
export function resolveMapAddress(
  input: LoadedMapNote | MapBlock,
  address: string,
  options: MapResolveOptions = {},
): MapReadResult {
  const map = isLoadedMapNote(input) ? input.map : input;
  const notePath = isLoadedMapNote(input) ? input.absolutePath : undefined;
  const kind = options.kind ?? mapKindOf(notePath);
  const at = options.at ?? defaultReadAt(kind);
  const contextDir = options.contextDir ?? (notePath ? dirname(notePath) : process.cwd());
  const roots = map.roots ?? [];

  let inspected: SpaceMapRootDrift[] | undefined;
  const inspectAll = () => (inspected ??= inspectSpaceMapRoots(roots, contextDir));
  const self = (): string | undefined => {
    if (options.self) return options.self;
    // The same identity rules discovery uses, so a checkout found as a root is also its own `//`.
    try {
      return checkoutRootNodeId(repoRoot(process.cwd())) ?? undefined;
    } catch {
      return undefined;
    }
  };

  let resolved = resolveMapPositionAddress(map, address, address.startsWith("//") ? { self: self() } : {});
  if (resolved.status === "unresolved" && resolved.code === "unknown_name") {
    // Only now pay for default names: they need every root's checkout.
    resolved = resolveMapPositionAddress(map, address, { defaultNames: defaultRootNames(inspectAll()) });
  }
  if (resolved.status !== "resolved") {
    return {
      status: "invalid_address",
      address,
      at,
      drift: false,
      reason: addressReason(resolved.code, address),
    };
  }

  const drift = inspected?.[resolved.rootIndex] ?? inspectSpaceMapRoots([resolved.root], contextDir)[0];
  const result = readMapRoot({ ...drift, rootIndex: resolved.rootIndex }, resolved.position, at, options.maxBytes);
  return { ...result, address };
}

/**
 * Read one position of an already-located Map root. The shared reader for every Map caller:
 * `resolveMapAddress`, agent discovery, and pinned Thread reads.
 */
export function readMapRoot(
  located: SpaceMapRootDrift,
  position: string,
  at: MapReadAt,
  maxBytes = MAP_READ_MAX_BYTES,
): MapReadResult {
  const { root, rootIndex, rootNodeId, checkoutPath, headSha, drift } = located;
  const base: MapReadResult = {
    status: "unreachable",
    ...(rootNodeId ? { canonical: formatMapPositionAddress({ root: { kind: "identity", rootNodeId }, position }) } : {}),
    rootIndex,
    root,
    position,
    at,
    pinnedSha: located.pinnedSha,
    headSha,
    drift,
    checkoutPath,
  };

  if (!checkoutPath) {
    return {
      ...base,
      reason: rootNodeId
        ? located.searchCapped
          ? `No local checkout of ${rootNodeId} in the local registry, and the search below the Map's folder stopped after ${CHECKOUT_SEARCH_LIMIT} folders; read the Map from a narrower folder or register the checkout.`
          : `No local checkout of ${rootNodeId} below the Map's folder or in the local registry.`
        : root.repo
          ? `The root's repo URL (${root.repo}) is not on this CLI's configured host; it is not trusted as a local binding.`
          : "The root carries no identity this reader can match to a checkout.",
    };
  }

  let commit: string;
  if (at === "pin") {
    commit = located.pinnedSha;
  } else if (headSha) {
    commit = headSha;
  } else {
    return { ...base, reason: `The checkout at ${checkoutPath} has no readable HEAD.` };
  }
  const read = readCheckoutAt(checkoutPath, commit, position, maxBytes);
  if (read.status === "read") {
    return {
      ...base,
      status: at === "pin" ? "checkout_at_pin" : "checkout_at_head",
      commit,
      kind: read.kind,
      ...(read.kind === "file" ? { content: read.content } : { entries: read.entries }),
    };
  }
  return { ...base, status: read.status === "git_error" ? "unreachable" : read.status, commit, reason: read.reason };
}

export type CheckoutRead =
  | { status: "read"; kind: "file"; content: string; path: string }
  | { status: "read"; kind: "directory"; entries: MapTreeEntry[]; path: string }
  | { status: "pin_absent" | "missing_path" | "too_large" | "git_error"; reason: string };

/**
 * Read one position from a commit of one checkout, never from the working tree.
 *
 * A `_threads/` position is looked up as authored first, then relative to a dedicated
 * `threads` branch whose tree is rooted at `_threads/` (schema/maps.md).
 */
export function readCheckoutAt(
  checkoutPath: string,
  commit: string,
  position: string,
  maxBytes = MAP_READ_MAX_BYTES,
): CheckoutRead {
  const availability = gitAvailability();
  if (availability.state !== "usable") return { status: "git_error", reason: availability.hint };
  if (!SHA.test(commit)) return { status: "pin_absent", reason: `${commit} is not a full commit id.` };

  const git = (args: string[], buffer = 64 * 1024) =>
    spawnSync("git", ["-C", checkoutPath, ...args], {
      encoding: "utf8",
      env: sanitizedGitEnvironment({ GIT_TERMINAL_PROMPT: "0" }),
      maxBuffer: buffer,
    });

  const exists = git(["cat-file", "-e", `${commit}^{commit}`]);
  if (exists.error) return { status: "git_error", reason: exists.error.message };
  if (exists.status !== 0) {
    const stderr = (exists.stderr ?? "").trim();
    if (/not a git repository/i.test(stderr)) return { status: "git_error", reason: stderr };
    return { status: "pin_absent", reason: `Commit ${commit} is not in the checkout at ${checkoutPath}.` };
  }

  const objectAt = (path: string) => (path === "." ? `${commit}^{tree}` : `${commit}:${path}`);
  const typeOf = (path: string): string | null => {
    const probe = git(["cat-file", "-t", objectAt(path)]);
    return probe.status === 0 ? probe.stdout.trim() : null;
  };
  const path = position === "_threads" || position.startsWith("_threads/")
    ? resolveThreadGitPath(position, (candidate) => typeOf(candidate || ".") !== null)
    : typeOf(position) !== null
      ? position
      : null;
  const type = path === null ? null : typeOf(path || ".");
  if (path === null || (type !== "blob" && type !== "tree")) {
    return { status: "missing_path", reason: `${position} is not in commit ${commit}.` };
  }

  if (type === "tree") {
    const listing = git(["ls-tree", "-z", objectAt(path || ".")], 16 * 1024 * 1024);
    if (listing.status !== 0) return { status: "git_error", reason: (listing.stderr ?? "").trim() || "git ls-tree failed" };
    const entries: MapTreeEntry[] = [];
    for (const line of listing.stdout.split("\0")) {
      const match = /^\d+ (blob|tree|commit) [0-9a-f]+\t([\s\S]+)$/.exec(line);
      if (match) entries.push({ name: match[2], type: match[1] === "tree" ? "directory" : "file" });
    }
    return { status: "read", kind: "directory", entries, path: path || "." };
  }

  const size = Number(git(["cat-file", "-s", objectAt(path)]).stdout.trim());
  if (Number.isFinite(size) && size > maxBytes) {
    return { status: "too_large", reason: `${position} is ${size} bytes; the read limit is ${maxBytes}.` };
  }
  const shown = git(["cat-file", "blob", objectAt(path)], maxBytes + 1);
  if (shown.status !== 0 || shown.error) {
    return { status: "git_error", reason: (shown.stderr ?? "").trim() || shown.error?.message || "git cat-file failed" };
  }
  return { status: "read", kind: "file", content: shown.stdout, path };
}

/**
 * This CLI's convenience, not protocol shape: other readers may supply other defaults, so an
 * address stored for later uses the identity form (`canonical`), never a default name.
 *
 * The names roots answer to when the Map gives them none: the hosted slug the local registry
 * holds for the identity, else the root's Agreement name as a token ("Agreement — Product" →
 * `product`). Read at the checkout's HEAD: a name is a local handle, not pinned content.
 */
export function defaultRootNames(located: readonly SpaceMapRootDrift[]): (string | undefined)[] {
  let spaces: SpacesMap = {};
  try {
    spaces = loadSpaces();
  } catch {
    // Without a registry, Agreement names still answer.
  }
  return located.map((root) => {
    if (root.rootNodeId) {
      for (const record of Object.values(spaces)) {
        if (!record || typeof record !== "object" || !isHostedSpaceRecord(record)) continue;
        if (record.root_node_id !== root.rootNodeId) continue;
        const slug = record.route_slug ?? record.slug;
        if (isMapRootName(slug)) return slug;
      }
    }
    if (!root.checkoutPath || !root.headSha) return undefined;
    const read = readCheckoutAt(root.checkoutPath, root.headSha, "_agent/agreement.md", 256 * 1024);
    if (read.status !== "read" || read.kind !== "file") return undefined;
    if (inspectFrontmatterSyntax(read.content).status !== "valid") return undefined;
    const name = parseFrontmatter(read.content)?.name;
    return typeof name === "string" ? nameToken(name) : undefined;
  });
}

function nameToken(name: string): string | undefined {
  const token = name
    .replace(/^\s*Agreement\s*[—–-]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return isMapRootName(token) ? token : undefined;
}

function addressReason(code: string, address: string): string {
  switch (code) {
    case "invalid_address_form":
      return `${JSON.stringify(address)} is not a Map address; use @<root_node_id>//<position>, @<name>//<position>, or //<position>.`;
    case "invalid_root_reference":
      return `${JSON.stringify(address)} names its root with neither a root identity nor a valid name.`;
    case "invalid_position":
      return `${JSON.stringify(address)} has a position that is not a canonical repository-relative path.`;
    case "root_not_in_map":
      return `${JSON.stringify(address)} names a root this Map does not pin.`;
    case "unknown_name":
      return `${JSON.stringify(address)} names no root of this Map, by declared name or default name.`;
    case "ambiguous_root":
      return `${JSON.stringify(address)} matches more than one pinned root; address it by the root's name in this Map.`;
    case "ambiguous_name":
      return `${JSON.stringify(address)} matches more than one root by name; name the roots in the Map or use @<root_node_id>//.`;
    case "self_unknown":
      return `${JSON.stringify(address)} names this reader's own root, but the working directory's checkout has no known identity.`;
    default:
      return `${JSON.stringify(address)} could not be resolved (${code}).`;
  }
}
