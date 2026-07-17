/**
 * `ideaspaces ls [<path>]` — list files and folders under a path, typed.
 *
 * A bounded, noise-excluding listing for surfaces that need "what's under here":
 * the desktop drives it (with the workspace root) to power @-mention autocomplete
 * in a local Pi conversation, rendering `--json`; from a terminal it prints a
 * readable, typed list. Folders are marked as a plain folder, a code repo
 * (`.git`), or an ideaspace repo (`_agent/`). Runs entirely on disk, no network.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createOutput } from "../output.js";
import { listEntries, filterEntries, entryLabel } from "../file-listing.js";
import type { CommandDef } from "../types.js";

const USAGE = "ideaspaces ls [<path>] [--query <q>] [--limit N] [--json]";
const DEFAULT_LIMIT = 25;

export const lsCommand: CommandDef = {
  name: "ls",
  description: "List files and folders under a path (typed; powers @-mention autocomplete)",
  usage: USAGE,
  examples: [
    "ideaspaces ls",
    "ideaspaces ls ~/IdeaSpaces --json",
    "ideaspaces ls . --query awareness --limit 8 --json",
  ],
  async run(args, flags, global) {
    const output = createOutput(global);

    const root = resolve(args[0] ?? ".");
    try {
      if (!statSync(root).isDirectory()) {
        output.error(`Not a directory: ${root}`);
        return 1;
      }
    } catch (err) {
      // Distinguish "missing" from "present but unreadable" (e.g. EACCES) so the
      // message points at the real cause instead of always claiming absence.
      const code = (err as NodeJS.ErrnoException).code;
      output.error(code === "ENOENT" ? `No such directory: ${root}` : `Cannot read ${root}: ${String(err)}`);
      return 1;
    }

    const query = typeof flags.query === "string" ? flags.query : "";
    const rawLimit = typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;

    const { entries: scanned, truncated } = listEntries(root);
    const entries = filterEntries(scanned, query, limit);

    const data = { root, query, scanned: scanned.length, truncated, total: entries.length, entries };
    if (entries.length === 0) {
      const detail = query ? ` matching "${query}"` : "";
      output.result(data, `No files or folders${detail} under ${root}.`);
      return 0;
    }

    output.result(data, entries.map(entryLabel).join("\n"));
    return 0;
  },
};
