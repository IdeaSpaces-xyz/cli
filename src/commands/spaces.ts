import { exportHostedSpace } from "../auth/api.js";
import { writeNewMapNote } from "../local/map-note.js";
import { NODE_ID } from "./thread-flags.js";
import { parseBool } from "../argv.js";
import { apiErrorDetail, fetchCoordinationSpaces, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, name: string): string | undefined {
  return typeof flags[name] === "string" ? flags[name] : undefined;
}

export const spacesCommand: CommandDef = {
  name: "spaces",
  description: "Work with hosted Spaces (named Maps), not Repos",
  usage: "ideaspaces spaces [list] [--attached-to <ref>] [--include-dormant] [--json]",
  help: "ideaspaces spaces export <map-or-version-id> <file.map.md>\nExport makes an independent local copy, never synchronizes or grants content access. Existing files are never replaced. Other local Map work uses ideaspaces map.",
  examples: [
    "ideaspaces spaces export n_0123456789abcdef01234567 research.map.md",
    "ideaspaces spaces",
    "ideaspaces spaces --json",
    "ideaspaces spaces --attached-to repo:n_0123456789abcdef01234567",
    "ideaspaces spaces --include-dormant",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    const [sub] = args;
    if (sub === "export") {
      try {
        if (args.length !== 3 || !NODE_ID.test(args[1]) || Object.keys(flags).length) throw new Error("Usage: ideaspaces spaces export <map-or-version-id> <file.map.md>");
        const content = await exportHostedSpace(config, args[1]);
        const result = await writeNewMapNote(args[2], content);
        output.result({ ...result, source: args[1], copy: true }, `Exported a local copy: ${result.path}. Local and hosted Spaces update independently; nothing was shared.`);
        return 0;
      } catch (error) {
        output.error(error instanceof UnauthorizedError ? "Session expired. Run `ideaspaces login`." : apiErrorDetail(error));
        return 1;
      }
    }
    if (args.length > 1 || (sub !== undefined && sub !== "list")) {
      output.error("Usage: ideaspaces spaces [list] [--attached-to <ref>] [--include-dormant] [--json]");
      return 1;
    }

    const attachedTo = flagString(flags, "attached-to");
    const includeDormant = flags["include-dormant"] !== undefined ? parseBool(flags["include-dormant"]) : undefined;

    try {
      const result = await fetchCoordinationSpaces(config, {
        attached_to: attachedTo,
        include_dormant: includeDormant,
      });

      const text = result.spaces.length
        ? result.spaces
            .map((s) => {
              const rel = s.relationship ? ` · ${s.relationship}` : "";
              const actions = s.actions?.length ? ` [${s.actions.join(", ")}]` : "";
              const summaryLine = s.summary ? `\n  ${s.summary}` : "";
              return `${s.name} (${s.node_id}) · ${s.status}${rel}${actions}${summaryLine}`;
            })
            .join("\n")
        : "No coordination spaces found.";

      output.result(result, text);
      return 0;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        output.error("Session expired. Run `ideaspaces login`.");
        return 1;
      }
      output.error(apiErrorDetail(err));
      return 1;
    }
  },
};
