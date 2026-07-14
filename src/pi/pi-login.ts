/**
 * `ideaspaces pi-login` — configure a local-agent model provider by writing pi's
 * `auth.json`, so `pi-status` reports `ready` and a local turn can run. This is
 * the API-key path; browser/device-code OAuth is the streaming login (separate).
 *
 * The desktop shells this verb on its `needs-provider` state — the CLI owns the
 * credential write; no client parses or writes `~/.pi` itself.
 */

import { createOutput } from "../output.js";
import { readAuthFile, resolvePiAuthPath, upsertApiKey, writeAuthFile } from "./pi-auth.js";
import type { CommandDef } from "../types.js";

export const piLoginCommand: CommandDef = {
  name: "pi-login",
  description: "Configure a local-agent model provider (writes pi's auth.json)",
  usage: "ideaspaces pi-login --provider <id> --api-key <key> [--json]",
  examples: [
    "ideaspaces pi-login --provider anthropic --api-key sk-ant-…",
    "ideaspaces pi-login --provider openai --api-key sk-…",
  ],
  async run(_args, flags, global) {
    const output = createOutput(global);

    const provider = typeof flags.provider === "string" ? flags.provider.trim() : "";
    const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"].trim() : "";

    if (!provider) {
      output.error("Usage: ideaspaces pi-login --provider <id> --api-key <key>");
      return 1;
    }
    if (!apiKey) {
      // OAuth ("log in with…") is not wired into this verb yet — that's the
      // streaming login path. Until then a provider is configured with a key.
      output.error(
        `An API key is required: ideaspaces pi-login --provider ${provider} --api-key <key>`,
      );
      return 1;
    }

    const path = resolvePiAuthPath();
    const next = upsertApiKey(readAuthFile(path), provider, apiKey);
    try {
      writeAuthFile(path, next);
    } catch (err) {
      output.error(`Couldn't write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    // Never echo the key back — only that the provider is now configured.
    output.result(
      { provider, method: "api_key", configured: true, authPath: path },
      `Configured ${provider} with an API key. Run \`ideaspaces pi-status\` to confirm.`,
    );
    return 0;
  },
};
