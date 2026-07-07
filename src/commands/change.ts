/**
 * `ideaspaces change new [<handle>]` — mint a Change-Id.
 *
 * A Change-Id is an idea-snapshot coordinate: one id stamped as a `Change-Id`
 * trailer on every commit of a single decision, across files and repos. Minting
 * is pure and offline — the id is a handle, the meaning lives in the linked Note.
 *
 * The CLI only *mints* (stateless): holding an id "open" across commits is a
 * session concern owned by the calling surface (the MCP server, an editor). So
 * this command is deliberately just `new`; there is no open/close state here.
 */

import { mintChangeId, isValidChangeId } from "@ideaspaces/sdk";
import { createOutput, type Output } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

const USAGE = "ideaspaces change new [<handle>] [--handle <text>]";

// Mint a fresh Change-Id from an optional short decision handle (2–4 words).
// An empty handle is valid — it yields `chg_<suffix>`.
function cmdNew(args: string[], flags: Flags, output: Output): number {
  const handle = String(flags.handle ?? args[0] ?? "").trim();
  const changeId = mintChangeId(handle);
  // mintChangeId always returns a well-formed id; assert the invariant so a
  // future change to the minter can't silently emit something unstampable.
  if (!isValidChangeId(changeId)) {
    output.error(`Minted an invalid Change-Id: ${changeId}`);
    return 1;
  }
  output.result({ change_id: changeId }, changeId);
  return 0;
}

export const changeCommand: CommandDef = {
  name: "change",
  description: "Mint a Change-Id for a decision spanning multiple commits/repos",
  usage: USAGE,
  examples: [
    'ideaspaces change new "auth session model"',
    "ideaspaces change new --handle surface-collapse --json",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    const sub = args[0];
    if (sub === "new") return cmdNew(args.slice(1), flags, output);
    output.error(`Usage: ${USAGE}`);
    return 1;
  },
};
