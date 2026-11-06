import { readFileSync } from "node:fs";
import { fetchVaults, importHostedSpace } from "../auth/api.js";
import { loadMapNote } from "../local/map-note.js";
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
  help: "ideaspaces spaces import <file.map.md>\nImport creates an independent hosted copy in your personal Vault. It creates no new Core Thread, grants no access and never synchronizes your local Map. Company import is not supported by this endpoint.",
  examples: [
    "ideaspaces spaces import research.map.md --json",
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
    if (sub === "import") {
      let sent = false;
      try {
        if (args.length !== 2 || Object.keys(flags).length) throw new Error("Usage: ideaspaces spaces import <file.map.md> [--json]. The copy goes into your personal Vault.");
        // Shape read only: never resolve/fetch referenced content or change the source.
        const local = loadMapNote(args[1], process.cwd());
        const markdown = readFileSync(local.absolutePath, "utf8");
        if (Buffer.byteLength(markdown, "utf8") > 1024 * 1024) throw new Error("Map copy exceeds the 1 MiB import limit.");
        // The import endpoint predates person-only writes. Refuse agent credentials
        // through the existing person-only Vaults authority before attempting it.
        await fetchVaults(config);
        sent = true;
        const result = await importHostedSpace(config, markdown);
        output.result(result, "Imported a hosted copy into your personal Vault. Local and hosted Spaces update independently. No new Core Thread or content access was created.");
        return 0;
      } catch (error) {
        output.error(error instanceof UnauthorizedError ? "Session expired. Run `ideaspaces login`." : apiErrorDetail(error));
        if (sent) output.error("Import was not retried. If its outcome is uncertain, check spaces list --hosted before importing again; another import creates another copy.");
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
