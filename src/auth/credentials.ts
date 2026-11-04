/**
 * Credential storage for IdeaSpaces login.
 *
 * Stores an access/rotating-refresh session (or an existing API key) in the CLI's
 * owner-only ~/.ideaspaces/credentials.json. Session changes use withCredentialsLock.
 * Auth resolution: IS_API_KEY env var → stored credentials → not logged in.
 *
 * Host mode (IDEASPACES_AUTH=host): an app that holds its own sign-in runs this CLI
 * for local work. The process then never reads, locks, refreshes, writes or deletes
 * credentials.json, ignores IS_API_KEY, and refuses sign-in and every remote call
 * with HostAuthRefusal. It keeps the CLI from using the terminal's sign-in; it is not
 * a wall against a same-user process reading the file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostToken } from "./host-token.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { configDir } from "./config-dir.js";

function credentialsFile(): string {
  return join(configDir(), "credentials.json");
}

// ─── Host mode ─────────────────────────────────────────────────────

export const HOST_AUTH_ENV = "IDEASPACES_AUTH";

/** True when an app that keeps its own sign-in runs this CLI (`IDEASPACES_AUTH=host`). */
export function isHostAuth(): boolean {
  return process.env[HOST_AUTH_ENV] === "host";
}

/** The plain refusal a host-mode CLI gives for sign-in and remote work. */
export function hostAuthMessage(what = "Remote IdeaSpaces work"): string {
  return `${what} isn't available from this \`ideaspaces\` command: it runs inside an app that holds its own sign-in (${HOST_AUTH_ENV}=host). Remote work is coming through the IdeaSpaces tools; local commands work here.`;
}

export class HostAuthRefusal extends Error {
  readonly code = "HOST_AUTH";
  constructor(what?: string) {
    super(hostAuthMessage(what));
    this.name = "HostAuthRefusal";
  }
}

function refuseInHostMode(): void {
  if (isHostAuth()) throw new HostAuthRefusal();
}

export interface StoredCredentials {
  api_url: string;
  api_key: string;
  /** Account handle, cached at login for offline display. Absent on pre-username creds. */
  username?: string | null;
  session?: StoredSession;
}

export interface StoredSession {
  id: string;
  install_id: string;
  refresh_token: string;
  expires_at: number;
  refresh_expires_at: number;
  /** Persisted before a rotating refresh: a crash/lost response must never replay it. */
  refreshing?: boolean;
}

export async function withCredentialsLock<T>(work: () => Promise<T>): Promise<T> {
  refuseInHostMode();
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    // ~20s covers the token request's 15s deadline plus store I/O; still bounded for Git.
    release = await lockfile.lock(credentialsFile(), { realpath: false, stale: 30_000, update: 10_000,
      retries: { retries: 100, minTimeout: 100, maxTimeout: 200 } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("Sign-in storage is locked by another CLI operation or a recently interrupted one. Wait briefly and retry.");
    throw error;
  }
  try { return await work(); } finally { await release(); }
}

export function loadStoredCredentials(): StoredCredentials | null {
  if (isHostAuth()) return null;
  const file = credentialsFile();
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data.api_key !== "string" || !data.api_key || (data.api_url !== undefined && typeof data.api_url !== "string")) return null;
    if (data.session !== undefined) {
      const s = data.session;
      if (!data.api_url || !s || typeof s.id !== "string" || !s.id || typeof s.install_id !== "string" || !s.install_id || typeof s.refresh_token !== "string" || !s.refresh_token ||
        !Number.isFinite(s.expires_at) || !Number.isFinite(s.refresh_expires_at) || (s.refreshing !== undefined && typeof s.refreshing !== "boolean")) return null;
    }
    return { ...data, api_url: data.api_url || DEFAULT_API_URL } as StoredCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  refuseInHostMode();
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const temp = `${credentialsFile()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, credentialsFile());
  } finally { try { unlinkSync(temp); } catch { /* renamed or never created */ } }
}

export function deleteCredentials(): void {
  refuseInHostMode();
  const file = credentialsFile();
  try {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// ─── Config resolution ─────────────────────────────────────────────

const DEFAULT_API_URL = "https://api.ideaspaces.xyz";

let warnedRefusedOverride = false;

/** Every "Not logged in" after this would mislead: the sign-in exists, and it was held back. */
function warnRefusedOverride(service: string, override: string): void {
  if (warnedRefusedOverride) return;
  warnedRefusedOverride = true;
  const shown = override.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  process.stderr.write(
    `Your stored IdeaSpaces sign-in belongs to ${service}, so it was not sent to ${shown} (IS_API_URL).\n` +
      "To use your sign-in, unset IS_API_URL. To use that server, set IS_API_KEY to a key for it.\n",
  );
}

export interface LoadedConfig {
  apiUrl: string;
  apiKey: string;
  /** Cached account handle from login, when present. Env-key config carries none. */
  username?: string | null;
  /** Session binding, not a secret; omitted for explicit env/API-key authentication. */
  sessionId?: string;
}

/**
 * Load config from env vars or stored credentials.
 *
 * Resolution order:
 * 1. IS_API_KEY env var (explicit override, CI)
 * 2. Stored credentials from login (~/.ideaspaces/credentials.json)
 * 3. null — not logged in
 *
 * In host mode it throws HostAuthRefusal: a caller asking for a sign-in is about
 * to do remote work. A caller that only asks whether one exists uses peekConfig.
 *
 * Per-folder repo binding lives in `auth/spaces.ts` (folder-keyed map),
 * not in this struct.
 */
export function loadConfig(): LoadedConfig | null {
  refuseInHostMode();
  const envKey = process.env.IS_API_KEY;
  if (envKey) {
    return {
      apiUrl: (process.env.IS_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
      apiKey: envKey,
    };
  }

  const stored = loadStoredCredentials();
  if (stored) {
    const apiUrl = (process.env.IS_API_URL || stored.api_url).replace(/\/$/, "");
    const service = stored.api_url.replace(/\/$/, "");
    // A stored credential, session or key, belongs to its service, never an IS_API_URL override.
    // IS_API_KEY is how a caller pairs a key with another server: that pair is theirs to name.
    if (apiUrl !== service) {
      warnRefusedOverride(service, apiUrl);
      return null;
    }
    return {
      apiUrl,
      apiKey: stored.api_key,
      username: stored.username ?? null,
      ...(stored.session ? { sessionId: stored.session.id } : {}),
    };
  }

  return null;
}

/** For a local read that only asks whether a sign-in exists or which service: none in host mode. */
export function peekConfig(): LoadedConfig | null {
  return isHostAuth() ? null : loadConfig();
}

/** A hosted-verb config: the host's per-call token in host mode, marked so only these verbs spend it. */
export interface HostedConfig extends LoadedConfig { host?: true }

/**
 * The sign-in a hosted Thread or Vault verb runs under, and nothing else.
 *
 * In host mode: only the token the host passed on `--token-fd`, never IS_API_KEY or
 * credentials.json, with no session binding, so it is never refreshed or written.
 * Without that token, host mode refuses as before. Outside host mode: the terminal's
 * own `login` (or IS_API_KEY), exactly as every other remote command uses it.
 */
export function hostedConfig(what: string): HostedConfig {
  if (isHostAuth()) {
    const token = hostToken();
    if (!token) throw new HostAuthRefusal(what);
    return { apiUrl: token.apiUrl, apiKey: token.accessToken, host: true };
  }
  const config = loadConfig();
  if (!config) throw new Error(`Not logged in. Run \`ideaspaces login\` to use ${what.charAt(0).toLowerCase()}${what.slice(1)}.`);
  return config;
}

export function getDefaultApiUrl(): string {
  return (process.env.IS_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
}

/** Public-read configuration: use ambient credentials when present, never invent an empty token. */
export function loadOptionalAuthConfig(): { apiUrl: string; apiKey?: string; sessionId?: string } {
  return loadConfig() ?? { apiUrl: getDefaultApiUrl() };
}
