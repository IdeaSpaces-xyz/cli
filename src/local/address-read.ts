import { isAbsolute } from "node:path";
import type { ContractSource, MapDepth } from "@ideaspaces/protocol";
import { loadMapNote, type LoadedMapNote } from "./map-note.js";
import { focusAtCommit, lookAtCommit, type CommitFocus, type CommitLook } from "./map-look.js";
import { defaultRootNames, resolveMapAddress, type MapReadAt, type MapReadResult } from "./map-resolve.js";

/**
 * The launch Map. `agent run --map` and `conversation send --map` set it, as an absolute path,
 * in the launched session's environment; the CLI, the MCP server and Pi read addresses against
 * it when a call names no Map. A convenience, not a boundary: it grants and restricts nothing.
 */
export const LAUNCH_MAP_ENV = "IDEASPACES_MAP";

/** The environment for a launched session: its own launch Map, or none — never the caller's. */
export function launchMapEnv(base: NodeJS.ProcessEnv, mapPath: string | undefined): NodeJS.ProcessEnv {
  const env = { ...base };
  if (mapPath) env[LAUNCH_MAP_ENV] = mapPath;
  else delete env[LAUNCH_MAP_ENV];
  return env;
}

/** `@<root>//<position>` or `//<position>`: a Map address, never a filesystem path. */
export function looksLikeMapAddress(value: string): boolean {
  return value.startsWith("//") || /^@[^/\s]+\/\//.test(value);
}

/** The Map an address is read against: the one named, else the launch Map. */
export function selectReadMap(flag: string | boolean | undefined, cwd = process.cwd()): LoadedMapNote {
  if (flag === true || (typeof flag === "string" && !flag.trim())) {
    throw new Error("A map-note path is required: --map <file.md>");
  }
  if (typeof flag === "string") return loadMapNote(flag, cwd);
  const launched = process.env[LAUNCH_MAP_ENV]?.trim();
  if (launched) {
    if (!isAbsolute(launched)) throw new Error(`${LAUNCH_MAP_ENV} must be an absolute path to a map note; it is ${JSON.stringify(launched)}.`);
    // Shown as launched: a path relative to whatever cwd this read runs in says nothing.
    return { ...loadMapNote(launched, cwd), path: launched };
  }
  throw new Error(
    "An address is read through a Map, and none was given: pass --map <note.md>, or launch the session with --map.",
  );
}

export function parseReadAt(value: string | boolean | undefined): MapReadAt | undefined | null {
  if (value === undefined) return undefined;
  return value === "pin" || value === "head" ? value : null;
}

export interface AddressRead {
  ok: boolean;
  /** What the agent reads: a header naming the root and commit, then the protocol's rendering. */
  text: string;
  data: Record<string, unknown>;
}

interface AddressReadOptions {
  at?: MapReadAt;
  contractSource?: ContractSource;
}

/** Look at a Map member by address, at the pin or HEAD, without a filesystem path. */
export async function lookAtAddress(
  note: LoadedMapNote,
  address: string,
  options: AddressReadOptions & { depth: MapDepth; maxChildren?: number },
): Promise<AddressRead> {
  return readAddress(note, address, options, (target) =>
    lookAtCommit(target, {
      depth: options.depth,
      ...(options.contractSource ? { contractSource: options.contractSource } : {}),
      ...(options.maxChildren !== undefined ? { maxChildren: options.maxChildren } : {}),
    }),
  );
}

/** Focus on a Map member directory by address: its contract, depth-one tree and skills, as reference. */
export async function focusAtAddress(note: LoadedMapNote, address: string, options: AddressReadOptions): Promise<AddressRead> {
  return readAddress(note, address, options, (target) => focusAtCommit(target, options.contractSource));
}

async function readAddress(
  note: LoadedMapNote,
  address: string,
  options: AddressReadOptions,
  read: (target: Parameters<typeof lookAtCommit>[0]) => Promise<CommitLook | CommitFocus>,
): Promise<AddressRead> {
  const resolved = resolveMapAddress(note, address, options.at ? { at: options.at } : {});
  const name = rootName(resolved);
  const base = describe(note, resolved, name);
  const header = renderHeader(note, resolved, name);

  if (resolved.status !== "checkout_at_pin" && resolved.status !== "checkout_at_head") {
    const reason = resolved.reason ?? resolved.status;
    return { ok: false, text: `${header}\n  status: ${resolved.status} — ${reason}`, data: { ...base, reason } };
  }

  const prefix = `@${name ?? resolved.root?.root_node_id ?? `${resolved.rootIndex}`}//`;
  const read_ = await read({
    checkoutPath: resolved.checkoutPath!,
    commit: resolved.commit!,
    position: resolved.position!,
    kind: resolved.kind!,
    label: { root: prefix, prefix },
  });
  if (read_.status === "ok") {
    return {
      ok: true,
      text: `${header}\n\n${read_.text}`,
      data: { ...base, text: read_.text, ...structured(read_.result) },
    };
  }
  const reason = "reason" in read_ ? read_.reason : read_.text;
  return {
    ok: false,
    text: `${header}\n  status: ${read_.status} — ${reason}`,
    data: { ...base, status: read_.status, reason },
  };
}

function structured(result: object): Record<string, unknown> {
  const { reference, target, ...rest } = result as Record<string, unknown>;
  return target ? { reference, target } : { focus: rest };
}

/** The root's name in this Map, else the name it answers to by default. */
export function rootName(resolved: MapReadResult): string | undefined {
  if (resolved.root?.name) return resolved.root.name;
  if (!resolved.root || resolved.rootIndex === undefined) return undefined;
  const [name] = defaultRootNames([
    {
      root: resolved.root,
      rootIndex: resolved.rootIndex,
      rootNodeId: resolved.root.root_node_id ?? null,
      repo: resolved.root.repo ?? null,
      pinnedSha: resolved.pinnedSha ?? resolved.root.sha,
      status: "pinned",
      drift: resolved.drift,
      headSha: resolved.headSha ?? null,
      checkoutPath: resolved.checkoutPath ?? null,
    },
  ]);
  return name;
}

function describe(note: LoadedMapNote, resolved: MapReadResult, name: string | undefined): Record<string, unknown> {
  return {
    source: "map",
    map: note.path,
    address: resolved.address,
    ...(resolved.canonical ? { canonical: resolved.canonical } : {}),
    status: resolved.status,
    ...(resolved.root
      ? {
          root: {
            index: resolved.rootIndex,
            ...(name ? { name } : {}),
            ...(resolved.root.root_node_id ? { root_node_id: resolved.root.root_node_id } : {}),
            ...(resolved.root.repo ? { repo: resolved.root.repo } : {}),
          },
        }
      : {}),
    ...(resolved.position ? { position: resolved.position } : {}),
    at: resolved.at,
    ...(resolved.commit ? { commit: resolved.commit } : {}),
    ...(resolved.pinnedSha ? { pinned_sha: resolved.pinnedSha } : {}),
    ...(resolved.headSha !== undefined ? { head_sha: resolved.headSha } : {}),
    drift: resolved.drift,
    ...(resolved.kind ? { kind: resolved.kind } : {}),
  };
}

function renderHeader(note: LoadedMapNote, resolved: MapReadResult, name: string | undefined): string {
  const lines = [`Map read: ${resolved.address}`];
  if (resolved.root) {
    const identity = resolved.root.root_node_id ?? resolved.root.repo ?? "no identity";
    lines.push(`  root: ${name ?? "(unnamed)"} — ${identity} (root ${resolved.rootIndex} of ${note.path})`);
  } else {
    lines.push(`  map: ${note.path}`);
  }
  if (resolved.canonical) lines.push(`  canonical: ${resolved.canonical}`);
  if (resolved.commit) {
    const drift = resolved.drift
      ? resolved.at === "head"
        ? ` — drifted from pin ${resolved.pinnedSha}`
        : ` — checkout HEAD has moved to ${resolved.headSha}`
      : "";
    lines.push(`  at: ${resolved.at} ${resolved.commit}${drift}`);
  } else {
    lines.push(`  at: ${resolved.at}`);
  }
  return lines.join("\n");
}
