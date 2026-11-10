import { createHash, randomUUID } from "node:crypto";
import { parseThreadPost } from "@ideaspaces/protocol";
import { ApiStatusError, apiErrorDetail, createHostedSpace, fetchAuthMe, NetworkError, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { GlobalFlags } from "../types.js";
import { buildNote } from "./hosted-threads.js";
import { NODE_ID, type Flags } from "./thread-flags.js";
import { allowedFlags } from "../agent-tools/flags.js";

export const SPACE_NEW_USAGE = "ideaspaces spaces new --hosted --vault <personal|person:user_ID|node:ORG_NODE_ID> --name <name> --summary <summary> --message <Core-opening> [--command-id <id>] [--json]";

function value(flags: Flags, key: string): string {
  const raw = flags[key];
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`--${key} needs a value.`);
  return raw.trim();
}

function line(flags: Flags, key: string, max: number): string {
  const result = value(flags, key);
  if (/[\r\n]/.test(result) || [...result].length > max) throw new Error(`--${key} must be one line of at most ${max} characters.`);
  return result;
}

export async function runHostedSpaceNew(args: string[], flags: Flags, global: GlobalFlags): Promise<number> {
  const output = createOutput(global);
  let commandId: string | undefined;
  let attempted = false;
  try {
    const known = allowedFlags("spaces.new");
    const unknown = Object.keys(flags).find(f => !known.has(f));
    if (unknown) throw new Error(`Unknown flag for spaces new: --${unknown}.`);
    if (args.length || flags.hosted !== true) throw new Error(SPACE_NEW_USAGE);
    const vault = value(flags, "vault");
    if (vault !== "personal" && (vault.length > 512 || !(/^person:user_[1-9][0-9]*$/.test(vault) || (vault.startsWith("node:") && NODE_ID.test(vault.slice(5)))))) {
      throw new Error("--vault must be personal or a canonical owner: person:user_ID or node:ORG_NODE_ID. A personal user ID is not a person Node ID; handles and local paths are not Vault owners.");
    }
    const name = line(flags, "name", 200);
    const summary = line(flags, "summary", 1000);
    const message = value(flags, "message");
    commandId = flags["command-id"] === undefined ? randomUUID() : line(flags, "command-id", 64);
    // No date or new random post id on retry: one command in one Vault has one opening.
    const postId = `msg_${createHash("sha256").update(`space-core:v1\0${vault}\0${commandId}`).digest("hex").slice(0, 48)}`;
    const coreNote = buildNote({ id: postId, kind: "post", name: `${name} Core`, summary }, message);
    const parsed = parseThreadPost(coreNote, "opening.md");
    if (parsed.status !== "valid") throw new Error("Invalid Core opening. Check --name, --summary and --message.");
    const config = loadConfig();
    if (!config) throw new Error("Not logged in. Run `ideaspaces login`.");
    let owner = vault;
    if (vault === "personal") {
      const me = await fetchAuthMe(config, { statusError: true });
      if (!Number.isSafeInteger(me?.user_id) || me.user_id < 1) throw new Error("Could not identify your personal Vault; no Space was created. Retry, or specify its canonical person:user_ID owner.");
      owner = `person:user_${me.user_id}`;
    }
    attempted = true;
    const result = await createHostedSpace(config, { command_id: commandId, owner, name, summary, core_note: coreNote });
    output.result({ ...result, command_id: commandId }, `Created hosted Space ${result.map_id} in ${result.owner}.\nCore: ${result.core_thread_id}\nVersion: ${result.version_id}\nCommand: ${commandId}\nNothing else was shared. Read spaces open ${result.map_id} --json for the current head, especially after an exact retry.`);
    return 0;
  } catch (error) {
    const message = error instanceof UnauthorizedError ? error.message
      : error instanceof ApiStatusError && error.status === 401 ? "Session expired. Run `ideaspaces login`."
      : error instanceof ApiStatusError && error.status === 402 ? "Creating a hosted Space requires an active Sync subscription. Check your plan, then retry this command."
      : error instanceof ApiStatusError && error.status === 403 ? `This sign-in cannot create a Space in that Vault. Use your own person sign-in and a Vault you own; a company Vault requires a current OWNER. ${apiErrorDetail(error)}`
      : apiErrorDetail(error);
    output.error(message);
    if (attempted && commandId) output.error(`Command: ${commandId}.`);
    if (attempted && (error instanceof NetworkError || error instanceof SyntaxError || (error instanceof ApiStatusError && error.status >= 500))) {
      output.error("The outcome may be uncertain; creation was not retried. Check spaces list --hosted. For an exact retry, keep the same --command-id, --vault, --name, --summary and --message; another command id creates another Space.");
    }
    return 1;
  }
}
