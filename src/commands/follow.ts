import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

const RETIRED = "Follow, unfollow and subscription cursor acknowledgement are retired. No request was sent. Use `ideaspaces threads list --unread` for unread Threads; use `ideaspaces threads ack <id> --cursor <cursor>` only to mark a Thread read explicitly.";

// Compatibility refusals, deliberately absent from the advertised command list.
function retired(name: string): CommandDef {
  return {
    name,
    description: "Retired: no subscription request is sent",
    usage: `ideaspaces ${name} (retired)`,
    examples: [],
    help: RETIRED,
    async run(_args, _flags, global) {
      createOutput(global).error(RETIRED);
      return 1;
    },
  };
}

export const followCommand = retired("follow");
export const unfollowCommand = retired("unfollow");
