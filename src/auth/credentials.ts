/**
 * Credential storage for IdeaSpaces login.
 *
 * Stores an access/rotating-refresh session (or an existing API key) in the CLI's
 * owner-only ~/.ideaspaces/credentials.json. Session changes use withCredentialsLock.
 * Auth resolution: IS_API_KEY env var → stored credentials → not logged in.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { configDir } from "./config-dir.js";

function credentialsFile(): string {
  return join(configDir(), "credentials.json");
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
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(credentialsFile(), { realpath: false, stale: 30_000, update: 10_000,
      retries: { retries: 25, minTimeout: 100, maxTimeout: 200 } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("Sign-in storage is locked by another CLI operation or a recently interrupted one. Wait briefly and retry.");
    throw error;
  }
  try { return await work(); } finally { await release(); }
}

export function loadStoredCredentials(): StoredCredentials | null {
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
 * Per-folder repo binding lives in `auth/spaces.ts` (folder-keyed map),
 * not in this struct.
 */
export function loadConfig(): LoadedConfig | null {
  const envKey = process.env.IS_API_KEY;
  if (envKey) {
    return {
      apiUrl: (process.env.IS_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
      apiKey: envKey,
    };
  }

  const stored = loadStoredCredentials();
  if (stored) {
    const apiUrl = (process.env.IS_API_URL || stored.api_url || DEFAULT_API_URL).replace(/\/$/, "");
    // A stored rotating session belongs to its service, never an IS_API_URL override.
    if (stored.session && apiUrl !== stored.api_url.replace(/\/$/, "")) return null;
    return {
      apiUrl,
      apiKey: stored.api_key,
      username: stored.username ?? null,
      ...(stored.session ? { sessionId: stored.session.id } : {}),
    };
  }

  return null;
}

export function getDefaultApiUrl(): string {
  return (process.env.IS_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
}

/** Public-read configuration: use ambient credentials when present, never invent an empty token. */
export function loadOptionalAuthConfig(): { apiUrl: string; apiKey?: string; sessionId?: string } {
  return loadConfig() ?? { apiUrl: getDefaultApiUrl() };
}
