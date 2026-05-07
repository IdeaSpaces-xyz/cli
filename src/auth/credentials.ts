/**
 * Credential storage for IdeaSpaces login.
 *
 * Stores API key + config in ~/.ideaspaces/credentials.json.
 * Auth resolution: IS_API_KEY env var → stored credentials → not logged in.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Compute lazily so tests can override HOME (constants captured at import
// time would freeze the path).
function configDir(): string {
  return join(homedir(), ".ideaspaces");
}

function credentialsFile(): string {
  return join(configDir(), "credentials.json");
}

export interface StoredCredentials {
  api_url: string;
  api_key: string;
}

export function loadStoredCredentials(): StoredCredentials | null {
  try {
    if (!existsSync(credentialsFile())) return null;
    const raw = readFileSync(credentialsFile(), "utf-8");
    const data = JSON.parse(raw);
    if (!data.api_key) return null;
    return data as StoredCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: StoredCredentials): void {
  if (!existsSync(configDir())) {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  }
  writeFileSync(credentialsFile(), JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function deleteCredentials(): void {
  try {
    if (existsSync(credentialsFile())) {
      unlinkSync(credentialsFile());
    }
  } catch {
    // Ignore — file may not exist
  }
}

// ─── Config resolution ─────────────────────────────────────────────

const DEFAULT_API_URL = "https://api.ideaspaces.xyz";

export interface LoadedConfig {
  apiUrl: string;
  apiKey: string;
  repo: string;
}

/**
 * Load config from env vars or stored credentials.
 *
 * Resolution order:
 * 1. IS_API_KEY env var (explicit override, CI)
 * 2. Stored credentials from login (~/.ideaspaces/credentials.json)
 * 3. null — not logged in
 */
export function loadConfig(): LoadedConfig | null {
  const envKey = process.env.IS_API_KEY;
  const envRepo = process.env.IS_REPO || "";
  if (envKey) {
    return {
      apiUrl: (process.env.IS_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
      apiKey: envKey,
      repo: envRepo,
    };
  }

  const stored = loadStoredCredentials();
  if (stored) {
    return {
      apiUrl: (process.env.IS_API_URL || stored.api_url || DEFAULT_API_URL).replace(/\/$/, ""),
      apiKey: stored.api_key,
      repo: envRepo,
    };
  }

  return null;
}

export function getDefaultApiUrl(): string {
  return (process.env.IS_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
}
