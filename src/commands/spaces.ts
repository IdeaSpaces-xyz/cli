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
  description: "List authorized coordination Spaces",
  usage: "ideaspaces spaces [list] [--attached-to <ref>] [--include-dormant] [--json]",
  examples: [
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
    if (sub !== undefined && sub !== "list") {
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
