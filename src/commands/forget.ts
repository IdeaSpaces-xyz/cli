import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { removeSpace } from "../auth/spaces.js";
import { createOutput } from "../output.js";
import type { CommandDef } from "../types.js";

export const forgetCommand: CommandDef = {
  name: "forget",
  description: "Stop tracking a local clone (optionally delete its folder)",
  usage: "ideaspaces forget <dir> [--delete]",
  examples: [
    "ideaspaces forget ./theone            # remove the binding, keep the files",
    "ideaspaces forget ./theone --delete   # remove the binding AND delete the folder",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const dirArg = args[0];
    if (!dirArg) {
      output.error("Usage: ideaspaces forget <dir> [--delete]");
      return 1;
    }
    const dir = resolve(dirArg);
    const del = Boolean(flags["delete"]);

    // Catastrophe stop — never delete a home directory or filesystem root, even
    // with --delete. This is NOT a synced-state guard (deletion is unconditional
    // by design); it only blocks an obviously ruinous target.
    if (del && (dir === resolve(homedir()) || dirname(dir) === dir)) {
      output.error(`Refusing to delete ${dir} — that's a home or root directory.`);
      return 1;
    }

    const wasTracked = removeSpace(dir);
    if (!wasTracked && !del) {
      output.error(`${dir} is not a tracked clone.`);
      return 1;
    }

    let deleted = false;
    if (del) {
      try {
        rmSync(dir, { recursive: true, force: true });
        deleted = true;
      } catch (err) {
        output.error(
          `Removed the binding, but couldn't delete ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    }

    output.result(
      { forgotten: true, deleted, path: dir },
      deleted ? `Freed up space — deleted ${dir}.` : `Forgot ${dir} (files kept).`,
    );
    return 0;
  },
};
