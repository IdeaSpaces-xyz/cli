/**
 * Git credential helper — invoked by git itself, not by users.
 *
 * Implements git's credential helper protocol:
 *   git runs `ideaspaces credential <action>` with credential context on stdin.
 *   Actions: get | store | erase.
 *
 * We implement `get` by reading the stored API key from
 * ~/.ideaspaces/credentials.json. `store` and `erase` are no-ops —
 * we manage our credentials through `ideaspaces login` / `logout`,
 * not through git's credential lifecycle.
 *
 * Scope: only responds for ideaspaces.xyz hosts. For any other host,
 * we write nothing and let git fall back to other helpers or prompt.
 *
 * See: git-credential(1), `gitcredentials` manpage.
 */

import { loadConfig } from "../auth/credentials.js";
import type { CommandDef } from "../types.js";

export const credentialCommand: CommandDef = {
  name: "credential",
  description:
    "Git credential helper (invoked by git — usually not run directly)",
  usage: "ideaspaces credential <get|store|erase>",
  async run(args) {
    const action = args[0];

    // Git always writes credential context on stdin; we must drain it
    // for store/erase even though we don't use the input.
    if (action === "store" || action === "erase") {
      await drainStdin();
      return 0;
    }

    if (action !== "get") {
      // Unknown action — drain stdin and exit non-zero so git surfaces it
      await drainStdin();
      return 1;
    }

    return handleGet();
  },
};

async function handleGet(): Promise<number> {
  const input = await readStdin();
  const params = parseCredentialInput(input);

  if (!isIdeaspacesHost(params.host)) {
    // Not our domain — silent no-op. Git will try other helpers / prompt.
    return 0;
  }

  const config = loadConfig();
  if (!config) {
    // Not logged in — git will prompt or other helpers will try.
    return 0;
  }

  // Any non-empty username works. Use git's provided one if any,
  // else a placeholder (server ignores username — password is the API key).
  const username = params.username && params.username.length > 0
    ? params.username
    : "token";

  const reply = [
    `username=${username}`,
    `password=${config.apiKey}`,
    "",
    "",
  ].join("\n");

  process.stdout.write(reply);
  return 0;
}

function isIdeaspacesHost(host: string | undefined): boolean {
  if (!host) return false;
  // Match the hosts we registered in git-credential-helper.ts
  return (
    host === "git.ideaspaces.xyz" ||
    host === "git.ideaspaces.localhost" ||
    host.endsWith(".ideaspaces.xyz")
  );
}

function parseCredentialInput(input: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    params[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return params;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function drainStdin(): Promise<void> {
  // Consume but ignore
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of process.stdin) {
    // discard
  }
}
