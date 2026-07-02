/**
 * `ideaspaces sync` — removed. Split into two directional commands so the
 * fundamental model stays legible: local and remote can each be ahead, and you
 * resolve that with a *direction*.
 *
 *   ideaspaces pull   integrate remote changes into your local ideaspace
 *   ideaspaces push   send your committed captures to the remote
 *
 * This tombstone stays only so older callers get a clear migration message
 * instead of "unknown command"; it does nothing and always fails. Delete once
 * every consumer (pi-is-space, desktop, plugin, obsidian) has migrated.
 */

import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const syncCommand: CommandDef = {
  name: "sync",
  description: "(removed) use `pull` then `push`",
  usage: "ideaspaces pull | ideaspaces push",
  async run(_args, _flags, global) {
    const output = createOutput(global);
    output.error(
      "`ideaspaces sync` has been split into two directional commands:\n" +
        "  ideaspaces pull   integrate remote changes into your local ideaspace\n" +
        "  ideaspaces push   send your committed captures to the remote\n" +
        "If you're diverged: pull first, then push.",
    );
    return 1;
  },
};
