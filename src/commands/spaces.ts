import { runHostedSpaceRemove, SPACE_REMOVE_USAGE } from "./hosted-space-remove.js";
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
  help: SPACE_REMOVE_USAGE + "\nOwner-only hosted edit. Remove deletes a reference, not content. The Core reference cannot be removed. Local Maps stay separate. --if-match is the hosted version_id, not a local file hash.",
  examples: [
    "ideaspaces spaces remove n_0123456789abcdef01234567 1 --if-match n_abcdef0123456789abcdef0123",
    "ideaspaces spaces",
    "ideaspaces spaces --json",
    "ideaspaces spaces --attached-to repo:n_0123456789abcdef01234567",
    "ideaspaces spaces --include-dormant",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    if (args[0] === "remove") return runHostedSpaceRemove(args.slice(1), flags, global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    const [sub] = args;
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
