import { randomUUID } from "node:crypto";
import { apiErrorDetail, removeHostedSpaceMember, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { GlobalFlags } from "../types.js";
import { NODE_ID, type Flags } from "./thread-flags.js";

export const SPACE_REMOVE_USAGE = "ideaspaces spaces remove <map-id> <member-ordinal> --if-match <head-version-id> [--command-id <id>] [--yes]";

export async function runHostedSpaceRemove(args: string[], flags: Flags, global: GlobalFlags): Promise<number> {
  const output = createOutput(global);
  let commandId: string | undefined;
  try {
    const unknown = Object.keys(flags).find(f => !["if-match", "command-id"].includes(f));
    if (unknown) throw new Error(`Unknown flag for spaces remove: --${unknown}.`);
    const [id, rawOrdinal] = args;
    if (args.length !== 2 || !NODE_ID.test(id ?? "") || !/^(0|[1-9]\d*)$/.test(rawOrdinal ?? "") || !Number.isSafeInteger(Number(rawOrdinal))) throw new Error(SPACE_REMOVE_USAGE);
    const head = flags["if-match"];
    if (typeof head !== "string" || !NODE_ID.test(head)) throw new Error("--if-match needs the head version_id from spaces open <map-id> --json. Ordinals belong to that exact head; reload and review if stale.");
    const given = flags["command-id"];
    if (given !== undefined && (typeof given !== "string" || !given.trim() || given.length > 64)) throw new Error("--command-id needs a value of at most 64 characters.");
    commandId = typeof given === "string" ? given : randomUUID();
    const ordinal = Number(rawOrdinal);
    const body = { command_id: commandId, expected_head_version_id: head };
    if (!global.yes) {
      output.result({ preview: true, map_id: id, member_ordinal: ordinal, ...body, access_checked: false },
        `Remove reference ${ordinal} from ${id} at head ${head}? This deletes no content. The Core reference cannot be removed.\nLocal preview only; access has not been checked. Confirm with --yes --command-id ${commandId} and the same --if-match.`);
      return 0;
    }
    const config = loadConfig();
    if (!config) throw new Error("Not logged in. Run `ideaspaces login`.");
    const result = await removeHostedSpaceMember(config, id, ordinal, body);
    output.result({ ...result, command_id: commandId }, `Removed reference ${ordinal} from ${id}. No content was deleted.\nHead: ${result.version_id}\nCommand: ${commandId}`);
    return 0;
  } catch (error) {
    output.error(error instanceof UnauthorizedError ? "Session expired. Run `ideaspaces login`." : apiErrorDetail(error));
    if (commandId) output.error(`Command: ${commandId}. If the outcome is uncertain, keep this --command-id, --if-match and ordinal on retry. Never use a newer head without reviewing it.`);
    return 1;
  }
}
