/**
 * `ideaspaces pi-logout` — remove a local-agent model provider from pi's
 * `auth.json`. Mirrors pi's `/logout`: it only drops the stored credential; it
 * does not touch models.json or any other config.
 */

import { createOutput } from "../output.js";
import { readAuthFile, removeProvider, resolvePiAuthPath, writeAuthFile } from "./pi-auth.js";
import type { CommandDef } from "../types.js";

export const piLogoutCommand: CommandDef = {
  name: "pi-logout",
  description: "Remove a local-agent model provider from pi's auth.json",
  usage: "ideaspaces pi-logout --provider <id> [--json]",
  examples: ["ideaspaces pi-logout --provider anthropic"],
  async run(_args, flags, global) {
    const output = createOutput(global);

    const provider = typeof flags.provider === "string" ? flags.provider.trim() : "";
    if (!provider) {
      output.error("Usage: ideaspaces pi-logout --provider <id>");
      return 1;
    }

    const path = resolvePiAuthPath();
    const { next, removed } = removeProvider(readAuthFile(path), provider);

    if (!removed) {
      output.result(
        { provider, removed: false, authPath: path },
        `${provider} was not configured — nothing to remove.`,
      );
      return 0;
    }

    try {
      writeAuthFile(path, next);
    } catch (err) {
      output.error(`Couldn't write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    output.result(
      { provider, removed: true, authPath: path },
      `Removed ${provider} from pi's providers.`,
    );
    return 0;
  },
};
