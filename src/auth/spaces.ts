/**
 * Folder-keyed registry of local IdeaSpaces.
 *
 * Stored at ~/.ideaspaces/spaces.json. Hosted bindings and unpublished local
 * forks are deliberately different states: a local fork has identity and
 * lineage, but no destination repo, route, namespace, or remote until publish.
 */

import { CURRENT_ROOT_NODE_ID_PATTERN, isValidRootNodeId } from "@ideaspaces/protocol";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configDir } from "./config-dir.js";

function spacesFile(): string {
  return join(configDir(), "spaces.json");
}

/** Canonical physical folder key when it exists; lexical absolute path otherwise. */
function folderKey(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export interface HostedSpaceRecord {
  /** Optional for compatibility with records written before the discriminator. */
  kind?: "hosted";
  repo_id: string;
  slug: string;
  /** Deprecated display fallback for records written before canonical root locators. */
  namespace: string;
  /** Stable Space identity. Optional only for reading legacy spaces.json records. */
  root_node_id?: string;
  route_status?: "resolved" | "unresolved" | "conflict" | "unavailable";
  route_namespace?: string | null;
  route_slug?: string | null;
  canonical_path?: string | null;
  /** Source Space lineage retained across first publication of a local fork. */
  source_root_node_id?: string;
  /** Source commit the copy was pinned at — the base any later update reads from. */
  source_head?: string;
  /** True once a durable post-fork source baseline has been written locally. */
  source_baseline_initialized?: boolean;
  name?: string;
}

/**
 * A locally owned fork that has never been published.
 *
 * The `never` fields make hosted-only assumptions fail at compile time while
 * keeping ordinary property access narrowable across the union. They are also
 * rejected at the JSON boundary so empty/synthetic destination bindings cannot
 * enter the registry through an untyped caller.
 */
export interface UnpublishedForkRecord {
  kind: "unpublished_fork";
  root_node_id: string;
  name: string;
  source_root_node_id: string;
  source_head: string;
  source_baseline_initialized: boolean;
  repo_id?: never;
  slug?: never;
  namespace?: never;
  route_status?: never;
  route_namespace?: never;
  route_slug?: never;
  canonical_path?: never;
}

export type SpaceRecord = HostedSpaceRecord | UnpublishedForkRecord;

/** Map of absolute folder path → local Space state. */
export type SpacesMap = Record<string, SpaceRecord>;

export function isUnpublishedForkRecord(record: SpaceRecord): record is UnpublishedForkRecord {
  return record.kind === "unpublished_fork";
}

export function isHostedSpaceRecord(record: SpaceRecord): record is HostedSpaceRecord {
  return record.kind !== "unpublished_fork";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseSpaceRecord(value: unknown): SpaceRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.kind === "unpublished_fork") {
    const forbidden = [
      "repo_id",
      "slug",
      "namespace",
      "route_status",
      "route_namespace",
      "route_slug",
      "canonical_path",
    ];
    if (forbidden.some((field) => field in record)) return null;
    if (
      !nonEmptyString(record.name) ||
      typeof record.root_node_id !== "string" ||
      !CURRENT_ROOT_NODE_ID_PATTERN.test(record.root_node_id) ||
      !isValidRootNodeId(record.source_root_node_id) ||
      record.root_node_id === record.source_root_node_id ||
      typeof record.source_head !== "string" ||
      !/^[0-9a-f]{40}$/i.test(record.source_head) ||
      typeof record.source_baseline_initialized !== "boolean"
    ) {
      return null;
    }
    return value as UnpublishedForkRecord;
  }

  if (record.kind !== undefined && record.kind !== "hosted") return null;
  if (
    !nonEmptyString(record.repo_id) ||
    !nonEmptyString(record.slug) ||
    typeof record.namespace !== "string"
  ) {
    return null;
  }
  if (record.root_node_id !== undefined && !isValidRootNodeId(record.root_node_id)) return null;
  if (
    record.source_root_node_id !== undefined &&
    !isValidRootNodeId(record.source_root_node_id)
  ) {
    return null;
  }
  return value as HostedSpaceRecord;
}

export function loadSpaces(): SpacesMap {
  const file = spacesFile();
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, "utf-8");
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
    const parsed: SpacesMap = {};
    for (const [path, value] of Object.entries(data)) {
      const record = parseSpaceRecord(value);
      if (record) parsed[path] = record;
    }
    return parsed;
  } catch {
    return {};
  }
}

export function saveSpace(absolutePath: string, record: SpaceRecord): void {
  const parsed = parseSpaceRecord(record);
  if (!parsed) {
    throw new Error("Refusing to save an invalid local Space registry record");
  }
  const key = folderKey(absolutePath);
  const map = loadSpaces();
  // Remove a lexical alias written by an older CLI (notably /tmp on macOS,
  // where git reports /private/tmp). One physical checkout must have one record.
  for (const existing of Object.keys(map)) {
    if (existing !== key && folderKey(existing) === key) delete map[existing];
  }
  map[key] = parsed;
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(spacesFile(), JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
}

export function findSpaceFor(absolutePath: string): SpaceRecord | null {
  const map = loadSpaces();
  const lexical = resolve(absolutePath);
  if (map[lexical]) return map[lexical];
  const canonical = folderKey(absolutePath);
  if (map[canonical]) return map[canonical];
  // Compatibility for records written before physical-path canonicalization.
  const alias = Object.entries(map).find(([path]) => folderKey(path) === canonical);
  return alias?.[1] ?? null;
}

/** The local registry as a list of `{ path, record }` — the shape consumers join on. */
export function listClones(): Array<{ path: string; record: SpaceRecord }> {
  return Object.entries(loadSpaces()).map(([path, record]) => ({ path, record }));
}

/** Remove a local registry binding. Returns false if it wasn't tracked. */
export function removeSpace(absolutePath: string): boolean {
  const canonical = folderKey(absolutePath);
  const map = loadSpaces();
  const keys = Object.keys(map).filter((path) => folderKey(path) === canonical);
  if (!keys.length) return false;
  for (const key of keys) delete map[key];
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(spacesFile(), JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  return true;
}

/**
 * Apply a verified hosted binding while retaining fork lineage only when the
 * previous record names the same destination identity.
 *
 * For an unpublished fork, matching `root_node_id` is the adoption handshake.
 * For legacy hosted records, matching `repo_id` preserves existing behavior.
 */
export function withForkLineage(
  bound: HostedSpaceRecord,
  previous: SpaceRecord | null,
): HostedSpaceRecord {
  const sameSpace = previous
    ? isUnpublishedForkRecord(previous)
      ? Boolean(bound.root_node_id && bound.root_node_id === previous.root_node_id)
      : previous.repo_id === bound.repo_id
    : false;
  if (!previous || !sameSpace) return bound;
  return {
    ...bound,
    ...(previous.source_root_node_id
      ? { source_root_node_id: previous.source_root_node_id }
      : {}),
    ...(previous.source_head ? { source_head: previous.source_head } : {}),
    ...(previous.source_baseline_initialized
      ? { source_baseline_initialized: true }
      : {}),
    ...(previous.name ? { name: previous.name } : {}),
  };
}
