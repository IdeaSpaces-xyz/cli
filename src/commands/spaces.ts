import { runHostedSpaceAdd, SPACE_ADD_USAGE } from "./hosted-space-writes.js";
import { NODE_ID } from "./thread-flags.js";
import { parseBool } from "../argv.js";
import { apiErrorDetail, fetchCoordinationSpaces, fetchHostedSpaces, fetchHostedSpace, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";

type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, name: string): string | undefined {
  return typeof flags[name] === "string" ? flags[name] : undefined;
}

function hostedArgsError(args: string[], flags: Flags): string | undefined {
  if (flags["attached-to"] !== undefined || flags["include-dormant"] !== undefined) return "Legacy list filters do not apply to hosted Spaces. Use spaces list --hosted.";
  const unknown = Object.keys(flags).find(f => f !== "hosted");
  if (unknown) return `Unknown flag for hosted Spaces: --${unknown}.`;
  if (args[0] === "open") {
    if (args.length !== 2) return "Usage: ideaspaces spaces open <map-id> [--json]";
    if (!NODE_ID.test(args[1])) return "Map IDs look like n_<12 or 24 lowercase hex digits>. Use spaces list --hosted to find one.";
  } else if (args.length > 1 || (args[0] !== undefined && args[0] !== "list")) {
    return "Usage: ideaspaces spaces list --hosted [--json]";
  }
  return undefined;
}

export const spacesCommand: CommandDef = {
  name: "spaces",
  description: "List or open hosted Spaces (named Maps); local Maps stay separate",
  usage: `ideaspaces spaces list --hosted [--json]
       ideaspaces spaces open <map-id> [--json]
       ideaspaces spaces [list] [--attached-to <ref>] [--include-dormant] [--json]
       ${SPACE_ADD_USAGE}`,
  help: "Owner-only hosted edits. --command-id accepts at most 64 characters. Local Maps stay separate. A Space is a view over references, not a Repo. Adding a reference shares nothing. Local and hosted Spaces are independent. Without --hosted, list shows legacy coordination objects. Open reads the hosted Map, not the content it points at.",
  examples: [
    "ideaspaces spaces add n_0123456789abcdef01234567 thread:x_example --if-match n_abcdef0123456789abcdef0123",
    "ideaspaces spaces list --hosted --json",
    "ideaspaces spaces open n_0123456789abcdef01234567 --json",
    "ideaspaces spaces",
    "ideaspaces spaces --json",
    "ideaspaces spaces --attached-to repo:n_0123456789abcdef01234567",
    "ideaspaces spaces --include-dormant",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    if (args[0] === "add") return runHostedSpaceAdd(args.slice(1), flags, global);

    const config = loadConfig();
    if (!config) {
      output.error("Not logged in. Run `ideaspaces login`.");
      return 1;
    }

    const [sub, id] = args;
    if (flags.hosted !== undefined && flags.hosted !== true) {
      output.error("--hosted takes no value. Leave it out for legacy coordination objects; local Maps use ideaspaces map.");
      return 1;
    }
    const hosted = flags.hosted === true;
    if (sub === "open" || hosted) {
      const error = hostedArgsError(args, flags);
      if (error) { output.error(error); return 1; }
      try {
        if (sub === "open") {
          const space = await fetchHostedSpace(config, id);
          const members = (space.members ?? []).map(m => `  ${m.address.ordinal}: ${m.address.authored_name ?? m.address.address ?? m.address.position_at_pin ?? "Reference"} · ${m.state}`);
          output.result(space, [
            `${space.authored.label} (${space.map_id})`,
            space.authored.summary ?? "", `Head: ${space.version_id}`,
            ...members, ...(space.omitted_members ? [`…and ${space.omitted_members} more references not shown.`] : []), "References do not grant access. Local Maps are unchanged.",
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
