import { runHostedSpaceNew, SPACE_NEW_USAGE } from "./hosted-space-new.js";
import { writeNewMapNote } from "../local/map-note.js";
import { loadMapNote } from "../local/map-note.js";
import { runHostedSpaceRemove, SPACE_REMOVE_USAGE } from "./hosted-space-remove.js";
import { runHostedSpaceAdd, SPACE_ADD_USAGE } from "./hosted-space-writes.js";
import { NODE_ID } from "./thread-flags.js";
import { parseBool } from "../argv.js";
import { ApiStatusError, NetworkError, fetchVaults, importHostedSpace, exportHostedSpace, apiErrorDetail, fetchCoordinationSpaces, fetchHostedSpaces, fetchHostedSpace, UnauthorizedError } from "../auth/api.js";
import { loadConfig } from "../auth/credentials.js";
import { createOutput } from "../output.js";
import type { CommandDef, GlobalFlags } from "../types.js";
import { allowedFlags } from "../agent-tools/flags.js";

type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, name: string): string | undefined {
  return typeof flags[name] === "string" ? flags[name] : undefined;
}

function hostedArgsError(args: string[], flags: Flags): string | undefined {
  if (flags["attached-to"] !== undefined || flags["include-dormant"] !== undefined) return "Legacy list filters do not apply to hosted Spaces. Use spaces list --hosted.";
  const allowed = allowedFlags(args[0] === "open" ? "spaces.open" : "spaces.list", "hosted");
  const unknown = Object.keys(flags).find(f => !allowed.has(f));
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
  description: "Create, read, edit and copy hosted Spaces (named Maps); local Maps stay separate",
  usage: `ideaspaces spaces list --hosted [--json]
       ideaspaces spaces open <map-id> [--json]
       ideaspaces spaces [list] [--attached-to <ref>] [--include-dormant] [--json]
       ${SPACE_NEW_USAGE}
       ${SPACE_ADD_USAGE}
       ${SPACE_REMOVE_USAGE}
       ideaspaces spaces import <file.map.md> [--json]
       ideaspaces spaces export <map-or-version-id> <file.map.md> [--json]`,
  help: "A Space is a view over references, not a Repo. Adding a reference shares nothing. Local and hosted Spaces update independently. Each referenced item keeps its own access checks.\n\nNew requires --hosted, an explicit --vault (personal, person:user_ID or node:ORG_NODE_ID), an active Sync subscription, and --name, --summary and --message for its Core opening. For a company, use node: followed by org_node_id from vaults --json; company Vaults require a current OWNER. The Core and Map are created together; nothing else is shared. Keep --command-id and every argument unchanged for an exact retry; the Core opening id is derived from that command and Vault.\n\nWithout --hosted, list shows legacy coordination objects. Hosted edits are owner-only. --if-match is the hosted version_id from spaces open --json, not a local file hash. Keep the original --command-id (up to 64 characters) and arguments for exact retries; read the current head afterwards.\n\nRemove previews locally; --yes confirms removal of a reference, never its content. The Core reference cannot be removed.\n\nImport creates a personal hosted copy with no new Core. Export creates an independent local UTF-8 Markdown copy and never overwrites an existing path; choose a new path to replace a copy. Use version_id from spaces open --json to export an exact version.",
  subcommands: {
    list: "ideaspaces spaces list --hosted [--json]\n       ideaspaces spaces list [--attached-to <ref>] [--include-dormant] [--json]",
    open: "ideaspaces spaces open <map-id> [--json]",
    new: SPACE_NEW_USAGE, add: SPACE_ADD_USAGE, remove: SPACE_REMOVE_USAGE,
    import: "ideaspaces spaces import <file.map.md> [--json]",
    export: "ideaspaces spaces export <map-or-version-id> <file.map.md> [--json]",
  },
  examples: [
    'ideaspaces spaces new --hosted --vault personal --name "Research" --summary "Our research" --message "We work here."',
    "ideaspaces spaces export n_0123456789abcdef01234567 research.map.md",
    "ideaspaces spaces export n_bbbbbbbbbbbbbbbbbbbbbbbb exact-version.map.md",
    "ideaspaces spaces import research.map.md --json",
    "ideaspaces spaces remove n_0123456789abcdef01234567 1 --if-match n_bbbbbbbbbbbbbbbbbbbbbbbb",
    "ideaspaces spaces add n_0123456789abcdef01234567 thread:x_example --if-match n_bbbbbbbbbbbbbbbbbbbbbbbb",
    "ideaspaces spaces list --hosted --json",
    "ideaspaces spaces open n_0123456789abcdef01234567 --json",
    "ideaspaces spaces",
    "ideaspaces spaces --json",
    "ideaspaces spaces --attached-to repo:n_0123456789abcdef01234567",
    "ideaspaces spaces --include-dormant",
  ],
  async run(args, flags, global: GlobalFlags) {
    const output = createOutput(global);
    if (args[0] === "new") return runHostedSpaceNew(args.slice(1), flags, global);
    if (args[0] === "remove") return runHostedSpaceRemove(args.slice(1), flags, global);
    if (args[0] === "add") return runHostedSpaceAdd(args.slice(1), flags, global);

    if (args[0] === "import" && (args.length !== 2 || Object.keys(flags).length)) {
      output.error("Usage: ideaspaces spaces import <file.map.md> [--json]. The copy goes into your personal Vault.");
      return 1;
    }
    if (args[0] === "export" && (args.length !== 3 || Object.keys(flags).length || !NODE_ID.test(args[1] ?? ""))) {
      output.error("Usage: ideaspaces spaces export <map-or-version-id> <file.map.md> [--json]");
      return 1;
    }
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
    if (sub === "import") {
      let sent = false;
      try {
        // Shape read only: never resolve/fetch referenced content or change the source.
        const local = loadMapNote(args[1], process.cwd());
        const markdown = local.content;
        if (Buffer.byteLength(markdown, "utf8") > 1024 * 1024) throw new Error("Map copy exceeds the 1 MiB import limit.");
        // The import endpoint predates person-only writes. Refuse agent credentials
        // through the existing person-only Vaults authority before attempting it.
        await fetchVaults(config);
        sent = true;
        const result = await importHostedSpace(config, markdown);
        const copiedId = result !== null && typeof result === "object" && "map_id" in result && typeof result.map_id === "string" ? result.map_id : undefined;
        output.result(result, `Imported a hosted copy${copiedId ? `: ${copiedId}` : ""} into your personal Vault. Local and hosted Spaces update independently. No new Core Thread or content access was created.`);
        return 0;
      } catch (error) {
        output.error(error instanceof UnauthorizedError ? error.message : error instanceof ApiStatusError && error.status === 401 ? "Session expired. Run `ideaspaces login`." : apiErrorDetail(error));
        // A successful write with unreadable JSON can have committed, just like a lost response.
        const uncertain = error instanceof NetworkError || error instanceof SyntaxError ||
          (error instanceof ApiStatusError && error.status >= 500);
        if (sent && uncertain) output.error("Import was not retried. If its outcome is uncertain, check spaces list --hosted before importing again; another import creates another copy.");
        return 1;
      }
    }
    if (sub === "export") {
      try {
        const content = await exportHostedSpace(config, args[1]);
        const result = await writeNewMapNote(args[2], content);
        output.result({ ...result, source: args[1], copy: true }, `Exported a local copy: ${result.path}. Local and hosted Spaces update independently; nothing was shared.`);
        return 0;
      } catch (error) {
        output.error(error instanceof UnauthorizedError ? "Session expired. Run `ideaspaces login`." : apiErrorDetail(error));
        return 1;
      }
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
            space.authored.summary ?? "", `Version: ${space.version_id}`,
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
