import { closeSync } from "node:fs";
import { HOST_AUTH_ENV, isHostAuth } from "./auth/credentials.js";
import { HostTokenError, readHostToken } from "./auth/host-token.js";

/** The only commands whose verbs spend a host token. Every other command refuses the flag. */
export const HOST_TOKEN_COMMANDS: ReadonlySet<string> = new Set(["vaults", "threads"]);

function closeQuietly(raw: string): void {
  if (/^\d+$/.test(raw) && Number(raw) >= 3) try { closeSync(Number(raw)); } catch { /* not open */ }
}

/**
 * Honour `--token-fd <n>` before the command runs: read the host's token once and
 * close the descriptor. Refused outside host mode and on commands that never spend it;
 * the descriptor is closed either way, so nothing the CLI starts can inherit it.
 */
export function takeTokenFd(raw: string | undefined, command: string | undefined): void {
  if (raw === undefined) return;
  if (!isHostAuth()) {
    closeQuietly(raw);
    throw new HostTokenError(`--token-fd is read only under ${HOST_AUTH_ENV}=host, where an app passes its own sign-in. In a terminal, sign in with \`ideaspaces login\`.`);
  }
  if (!command || !HOST_TOKEN_COMMANDS.has(command)) {
    closeQuietly(raw);
    throw new HostTokenError(`--token-fd is accepted only by \`ideaspaces vaults\` and the hosted \`ideaspaces threads\` verbs, not by ${command ?? "this command"}.`);
  }
  if (!/^\d+$/.test(raw)) throw new HostTokenError("--token-fd needs an inherited descriptor number of 3 or more.");
  readHostToken(Number(raw));
}
