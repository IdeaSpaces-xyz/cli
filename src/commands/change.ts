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

/**
 * Resolve the decision handle from `--handle` or the first positional. The flag
 * parser (argv.ts) hands back boolean `true` for a value-less `--handle` (last
 * token, or followed by another flag), so guard for a string — mirroring how
 * commit.ts reads its trailer flags. An empty handle is valid: `chg_<suffix>`.
 */
export function resolveHandle(flags: Flags, args: string[]): string {
  const fromFlag = typeof flags.handle === "string" ? flags.handle : "";
  return (fromFlag || args[0] || "").trim();
}

// Mint a fresh Change-Id from an optional short decision handle (2–4 words).
function cmdNew(args: string[], flags: Flags, output: Output): number {
  const changeId = mintChangeId(resolveHandle(flags, args));
  // mintChangeId always returns a well-formed id; assert the invariant so a
  // future change to the minter can't silently emit something unstampable.
  if (!isValidChangeId(changeId)) {
    output.error(`Minted an invalid Change-Id: ${changeId}`);
    return 1;
  }
  // Human output is the bare id (not a sentence like `conversation new`) so it
  // captures cleanly in a shell: `id=$(ideaspaces change new "handle")`.
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
