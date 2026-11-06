import { parseBool } from "../argv.js";
import { apiErrorDetail, fetchCoordinationSpaces, fetchHostedSpaces, fetchHostedSpace, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, name: string): string | undefined {
  return typeof flags[name] === "string" ? flags[name] : undefined;
}

export const spacesCommand: CommandDef = {
  name: "spaces",
  description: "List or open hosted Spaces (named Maps); local Maps stay separate",
  usage: "ideaspaces spaces list --hosted [--json]\n       ideaspaces spaces open <map-id> [--json]\n       ideaspaces spaces [list] [--attached-to <ref>] [--include-dormant] [--json]",
  help: "A Space is a view over references, not a Repo. Adding a reference shares nothing. Local and hosted Spaces are independent. Without --hosted, list shows legacy coordination objects. Open reads the hosted Map, not the content it points at.",
  examples: [
    "ideaspaces spaces list --hosted --json",
    "ideaspaces spaces open n_0123456789abcdef01234567 --json",
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

    const [sub, id] = args;
    const hosted = flags.hosted !== undefined && parseBool(flags.hosted);
    if (sub === "open" || hosted) {
      if ((sub === "open" && (args.length !== 2 || !/^n_[0-9a-f]{24}$/.test(id ?? ""))) ||
          (sub !== "open" && (args.length > 1 || (sub !== undefined && sub !== "list"))) ||
          flags["attached-to"] !== undefined || flags["include-dormant"] !== undefined) {
        output.error("Usage: ideaspaces spaces list --hosted | spaces open <map-id>. Legacy list filters do not apply to hosted Spaces.");
        return 1;
      }
      try {
        if (sub === "open") {
          const space = await fetchHostedSpace(config, id);
          const members = (space.members ?? []).map(m => `  ${m.address.ordinal}: ${m.address.authored_name ?? m.address.address ?? m.address.position_at_pin ?? "Reference"} · ${m.state}`);
          output.result(space, [
            `${space.authored.label} (${space.map_id})`,
            space.authored.summary ?? "", `Head: ${space.version_id}`,
            ...members, "References do not grant access. Local Maps are unchanged.",
          ].filter(Boolean).join("\n"));
        } else {
          const result = await fetchHostedSpaces(config);
          output.result(result, result.maps.length ? result.maps.map(s =>
            `${s.name} (${s.node_id}) · ${s.owner}${s.summary ? `\n  ${s.summary}` : ""}`
          ).join("\n") : "No hosted Spaces found.");
        }
        return 0;
      } catch (err) {
        output.error(err instanceof UnauthorizedError ? "Session expired. Run `ideaspaces login`." : apiErrorDetail(err));
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
