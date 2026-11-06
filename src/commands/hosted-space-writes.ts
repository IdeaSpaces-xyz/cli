import { randomUUID } from "node:crypto";
import { parseMap, type MapMember, type MapRoot } from "@ideaspaces/protocol";
import { apiErrorDetail, appendHostedSpaceMember, NetworkError, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { GlobalFlags } from "../types.js";
import { NODE_ID, type Flags } from "./thread-flags.js";

export const SPACE_ADD_USAGE = "ideaspaces spaces add <map-id> <address> --if-match <head-version-id> [--command-id <id>] [--depth name|summary] [--name <name>] [--summary <summary>]\n       ideaspaces spaces add <map-id> --position <path> --root-node-id <id> [--sha <commit>] --if-match <head-version-id> [--command-id <id>] [--depth name|summary|surface|children|full]";

function value(flags: Flags, key: string): string | undefined {
  if (flags[key] === undefined) return undefined;
  if (typeof flags[key] !== "string" || !String(flags[key]).trim()) throw new Error(`--${key} needs a value.`);
  return String(flags[key]);
}

export async function runHostedSpaceAdd(args: string[], flags: Flags, global: GlobalFlags): Promise<number> {
  const output = createOutput(global);
  let commandId: string | undefined;
  let attempted = false;
  try {
    const known = new Set(["if-match", "command-id", "position", "root-node-id", "sha", "depth", "name", "summary"]);
    const unknown = Object.keys(flags).find(f => !known.has(f));
    if (unknown) throw new Error(`Unknown flag for spaces add: --${unknown}.`);
    const [id, address] = args;
    if (!NODE_ID.test(id ?? "") || args.length > 2) throw new Error(SPACE_ADD_USAGE);
    const head = value(flags, "if-match");
    if (!head || !NODE_ID.test(head)) throw new Error("--if-match needs the head version_id from spaces open <map-id> --json. A stale head is refused; reload and review before trying again.");
    commandId = value(flags, "command-id") ?? randomUUID();
    if (commandId.length > 64) throw new Error("--command-id must be at most 64 characters.");
    const position = value(flags, "position");
    const rootId = value(flags, "root-node-id");
    const sha = value(flags, "sha");
    const depth = value(flags, "depth") ?? "summary";
    const name = value(flags, "name");
    const summary = value(flags, "summary");
    const roots: MapRoot[] = [];
    let member: MapMember;
    if (position !== undefined) {
      if (address || !rootId || !NODE_ID.test(rootId)) throw new Error("A position needs --root-node-id <id> and no address. It references a Repo; it does not upload one.");
      roots.push({ root_node_id: rootId, ...(sha ? { sha } : {}) });
      member = { root: 0, position, depth, ...(name ? { name } : {}), ...(summary ? { summary } : {}) } as MapMember;
    } else {
      if (!address || rootId || sha) throw new Error("Choose one address, or --position with --root-node-id (and optional --sha).");
      member = { address, depth, ...(name ? { name } : {}), ...(summary ? { summary } : {}) } as MapMember;
    }
    const parsed = parseMap({ roots, members: [member] });
    if (parsed.status !== "valid") throw new Error("Invalid Map reference. Check the address, repo-relative position, root, depth and pin.");
    const config = loadConfig();
    if (!config) throw new Error("Not logged in. Run `ideaspaces login`.");
    const validated = parsed.map.members[0];
    const hostedMember = "address" in validated ? validated : { ...validated, root: parsed.map.roots[validated.root] };
    attempted = true;
    const result = await appendHostedSpaceMember(config, id, { command_id: commandId, expected_head_version_id: head, member: hostedMember });
    output.result({ ...result, command_id: commandId }, `Added a reference to ${id}. Nothing was shared.\nHead: ${result.version_id}\nCommand: ${commandId}`);
    return 0;
  } catch (error) {
    output.error(error instanceof UnauthorizedError ? "Session expired. Run `ideaspaces login`." : apiErrorDetail(error));
    if (attempted && commandId) output.error(`Command: ${commandId}.`);
    if (attempted && (error instanceof NetworkError || error instanceof SyntaxError || (error instanceof Error && /→ 5\d\d:/.test(error.message)))) {
      output.error("The outcome may be uncertain. Keep the same --command-id, --if-match and arguments on retry. Never use a newer head without reviewing it.");
    }
    return 1;
  }
}
