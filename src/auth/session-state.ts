/**
 * Session state — persists last-seen HEAD SHA per repo.
 * Separate from credentials so logout doesn't lose session tracking.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".ideaspaces");
const SESSION_FILE = join(CONFIG_DIR, "session.json");

interface SessionData {
  [repoId: string]: {
    last_sha: string;
    updated_at: string;
  };
}

function loadAll(): SessionData {
  try {
    if (!existsSync(SESSION_FILE)) return {};
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveAll(data: SessionData): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

export function getLastSha(repoId: string): string | undefined {
  return loadAll()[repoId]?.last_sha;
}

export function setLastSha(repoId: string, sha: string): void {
  const data = loadAll();
  data[repoId] = { last_sha: sha, updated_at: new Date().toISOString() };
  saveAll(data);
}

export function clearSessionState(): void {
  try {
    if (existsSync(SESSION_FILE)) unlinkSync(SESSION_FILE);
  } catch {
    // Ignore
  }
}
