/**
 * Writing pi's `auth.json` — the model-provider credential store the bundled pi
 * reads to run a local turn. `pi-status` reads this file; `pi-login`/`pi-logout`
 * write it. The path + permissions mirror pi's own `getAgentDir()` /
 * `FileAuthStorageBackend` (0700 dir, 0600 file) so a credential we write is
 * exactly what the runtime loads.
 *
 * Credentials are pi's tagged union — see {@link PiCredential}. This module owns
 * the API-key form (`{type:"api_key", key}`); the OAuth form is written by the
 * streaming login path.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Raw `auth.json` credential — pi's tagged union, one entry per provider:
 *   - **api_key**: `{ type: "api_key", key, env? }`
 *   - **oauth**:   `{ type: "oauth", access, refresh, expires }`
 * Every field is optional here so a partial or hand-written file never throws on
 * parse; validity is derived (see `derivePiStatus`). `key` is the API-key form,
 * `access`/`refresh` the OAuth tokens — a provider is credentialed if it carries
 * any of them.
 */
export type PiCredential = {
  type?: "api_key" | "oauth";
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  env?: Record<string, string>;
};

/** Raw `auth.json` shape — a map of provider → credential record. */
export type PiAuth = Record<string, PiCredential | undefined>;

/**
 * pi's agent directory — `$PI_CODING_AGENT_DIR` (tilde-expanded) when set, else
 * `~/.pi/agent`. Mirrors pi's `getAgentDir()`, so a login writes where the
 * runtime reads. The bundle points this at its own dir; dev uses the default.
 */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
  return join(homedir(), ".pi", "agent");
}

/** Absolute path to pi's `auth.json`. */
export function resolvePiAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePiAgentDir(env), "auth.json");
}

/** Parse an `auth.json` body; empty/malformed → `{}` (never throws). A corrupt
 *  file is treated as "no providers" rather than an error the user can't act on. */
export function parseAuth(raw: string | undefined): PiAuth {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as PiAuth) : {};
  } catch {
    return {};
  }
}

/** Pure: set a provider's API-key credential, preserving every other provider. */
export function upsertApiKey(current: PiAuth, provider: string, key: string): PiAuth {
  return { ...current, [provider]: { type: "api_key", key } };
}

/** Pure: remove a provider. Returns the next map + whether it had been present. */
export function removeProvider(
  current: PiAuth,
  provider: string,
): { next: PiAuth; removed: boolean } {
  if (!(provider in current)) return { next: current, removed: false };
  const next = { ...current };
  delete next[provider];
  return { next, removed: true };
}

/** Read pi's `auth.json` (absent → `{}`). */
export function readAuthFile(path: string): PiAuth {
  if (!existsSync(path)) return {};
  return parseAuth(readFileSync(path, "utf8"));
}

/**
 * Write pi's `auth.json` with pi's own permissions (0700 dir, 0600 file), and
 * re-chmod even when the file pre-existed with looser perms.
 *
 * No file lock: pi uses `proper-lockfile` to serialize its own token refreshes,
 * but a `pi-login` is an explicit one-shot human action, so a concurrent
 * OAuth-refresh race is unlikely and self-correcting (re-run login). If/when this
 * module writes OAuth creds (the streaming path), revisit locking to match pi.
 */
export function writeAuthFile(path: string, auth: PiAuth): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}
