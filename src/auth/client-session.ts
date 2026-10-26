/** Per-install person sessions. Secrets stay in the CLI's existing owner-only store. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config-dir.js";
import { deleteCredentials, loadStoredCredentials, saveCredentials, withCredentialsLock, type StoredCredentials } from "./credentials.js";

export interface SessionConfig { apiUrl: string; apiKey?: string; sessionId?: string }
export class SessionAuthError extends Error {
  constructor(message = "Your IdeaSpaces sign-in ended. Run `ideaspaces login` again.") { super(message); this.name = "SessionAuthError"; }
}
class RequestNotSent extends Error {}
/** Only OS DNS/connect refusal proves that no HTTP request could reach this origin.
 * Resets, TLS errors, timeouts and mixed/unknown aggregate causes remain ambiguous. */
function definitelyNotSent(error: unknown): boolean {
  if (!(error instanceof TypeError) || !/fetch failed/i.test(error.message)) return false;
  const inspect = (cause: any): boolean => {
    if (Array.isArray(cause?.errors) && cause.errors.length) return cause.errors.every(inspect);
    return !!cause && ((["ENOTFOUND", "EAI_AGAIN"].includes(cause.code) && cause.syscall === "getaddrinfo") ||
      (cause.code === "ECONNREFUSED" && cause.syscall === "connect"));
  };
  return inspect((error as TypeError & { cause?: unknown }).cause);
}
export function serviceOrigin(service: string): string {
  const u = new URL(service);
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash ||
    !(u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) {
    throw new Error("Sign-in needs an HTTPS API origin (loopback HTTP is allowed for local testing).");
  }
  return u.origin;
}
/** Stable per CLI installation/service, retained on sign-out. Serialized with the credential lock. */
export function cliInstallId(apiUrl: string): string {
  const directory = join(configDir(), "installs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${createHash("sha256").update(serviceOrigin(apiUrl)).digest("hex")}.json`);
  try {
    const id = JSON.parse(readFileSync(file, "utf8")).install_id;
    if (typeof id === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(id)) return id;
    throw new Error("invalid install identity");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read the CLI install identity at ${file}. Restore its file before signing in; it was not replaced.`);
  }
  const install_id = randomUUID();
  writeFileSync(file, JSON.stringify({ install_id }) + "\n", { mode: 0o600, flag: "wx" });
  return install_id;
}

async function sessionRequest(apiUrl: string, action: "token" | "revoke", params: Record<string, string>): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${serviceOrigin(apiUrl)}/auth/desktop/${action}`, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      await response.body?.cancel();
      if (action === "token" && [400, 401, 403].includes(response.status)) throw new SessionAuthError();
      throw new Error(`IdeaSpaces ${action === "token" ? "token exchange" : "sign-out"} failed (HTTP ${response.status}). Try again later.`);
    }
    if (action === "revoke") { await response.body?.cancel(); return; }
    return await response.json();
  } catch (error) {
    if (error instanceof SessionAuthError) throw error;
    if (definitelyNotSent(error)) throw new RequestNotSent("Could not connect to IdeaSpaces (request was not sent). Check the API origin/network, then retry.");
    // Never print provider bodies, fetch causes, submitted codes/verifiers or tokens.
    throw new Error(`Could not complete IdeaSpaces ${action === "token" ? "token exchange" : "server sign-out"}. Check your connection. A rotating refresh is never retried automatically.`);
  }
}
const secret = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && /^[A-Za-z0-9._~+\/-]+=*$/.test(v);
function credentials(apiUrl: string, installId: string, raw: any, expectedId?: string): StoredCredentials {
  if (!raw || !secret(raw.access_token) || !secret(raw.refresh_token) || raw.token_type !== "Bearer" ||
    !Number.isFinite(raw.expires_in) || raw.expires_in <= 0 || !Number.isFinite(raw.refresh_expires_in) || raw.refresh_expires_in <= 0 ||
    !raw.session || typeof raw.session.id !== "string" || !raw.session.id || raw.session.install_id !== installId || raw.session.client !== "cli" ||
    (expectedId !== undefined && raw.session.id !== expectedId)) throw new SessionAuthError("The sign-in response was invalid. Run `ideaspaces login` again.");
  return { api_url: serviceOrigin(apiUrl), api_key: raw.access_token, session: { id: raw.session.id, install_id: installId,
    refresh_token: raw.refresh_token, expires_at: Date.now() + raw.expires_in * 1000, refresh_expires_at: Date.now() + raw.refresh_expires_in * 1000 } };
}
export async function exchangeSignIn(apiUrl: string, installId: string, code: string, verifier: string, redirectUri: string): Promise<StoredCredentials> {
  const raw = await sessionRequest(apiUrl, "token", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, install_id: installId });
  const next = credentials(apiUrl, installId, raw);
  // The server replaces a prior live session for this same person/install. Other
  // accounts/services and legacy keys require explicit logout/revocation, not a hidden write.
  await withCredentialsLock(async () => saveCredentials(next));
  return next;
}
function currentSession(config: SessionConfig): StoredCredentials {
  const stored = loadStoredCredentials();
  if (!stored?.session || stored.session.id !== config.sessionId || stored.api_url !== config.apiUrl.replace(/\/$/, "")) throw new SessionAuthError();
  return stored;
}
/** Every HTTP/git consumer resolves afresh; the cross-process lock includes refresh and durable rotation. */
export async function resolveSessionConfig<T extends SessionConfig>(config: T, rejectedKey?: string): Promise<T> {
  if (!config.sessionId) return config; // Env keys and existing legacy keys are unchanged.
  return withCredentialsLock(async () => {
    const stored = currentSession(config);
    const s = stored.session!;
    if (!secret(stored.api_key) || !secret(s.refresh_token) || typeof s.install_id !== "string" || !Number.isFinite(s.expires_at) || !Number.isFinite(s.refresh_expires_at)) throw new SessionAuthError();
    if (s.refreshing) throw new SessionAuthError("A rotating sign-in refresh was interrupted or its response was lost. Run `ideaspaces login` again; reusing that refresh could revoke this install.");
    if (s.refresh_expires_at <= Date.now()) { deleteCredentials(); throw new SessionAuthError(); }
    if (s.expires_at > Date.now() + 60_000 && stored.api_key !== rejectedKey) return { ...config, apiKey: stored.api_key };
    // A lost response may have consumed the refresh. Persist this before spending it, not after.
    saveCredentials({ ...stored, session: { ...s, refreshing: true } });
    try {
      const raw = await sessionRequest(stored.api_url, "token", { grant_type: "refresh_token", refresh_token: s.refresh_token, install_id: s.install_id });
      const next = { ...credentials(stored.api_url, s.install_id, raw, s.id), username: stored.username };
      const current = loadStoredCredentials();
      if (current?.session?.id !== s.id || current.session.refresh_token !== s.refresh_token || !current.session.refreshing || current.api_url !== stored.api_url) throw new SessionAuthError("This sign-in changed during refresh. Run the command again.");
      saveCredentials(next);
      return { ...config, apiKey: next.api_key };
    } catch (error) {
      const current = loadStoredCredentials();
      if (current?.session?.id === s.id && current.session.refresh_token === s.refresh_token && current.api_url === stored.api_url) {
        if (error instanceof SessionAuthError) deleteCredentials();
        else if (error instanceof RequestNotSent) saveCredentials({ ...current, session: { ...current.session, refreshing: undefined } });
      }
      // On ambiguous network/disk failure retain the marker; never silently replay a rotation.
      throw error;
    }
  });
}
/** Clear only this refused session, never a concurrent new login or an explicit env key. */
export async function refuseSession(config: SessionConfig, rejectedKey = config.apiKey): Promise<void> {
  if (!config.sessionId) return;
  await withCredentialsLock(async () => {
    const stored = loadStoredCredentials();
    if (stored && stored.session?.id === config.sessionId && stored.api_key === rejectedKey && stored.api_url === config.apiUrl.replace(/\/$/, "")) deleteCredentials();
  });
}
export async function cacheSessionUsername(config: SessionConfig, username: string): Promise<void> {
  await withCredentialsLock(async () => { const stored = currentSession(config); saveCredentials({ ...stored, username }); });
}
/** Offline failure keeps the local refresh for an explicit sign-out retry. Legacy keys are only forgotten. */
export async function signOut(): Promise<void> {
  await withCredentialsLock(async () => {
    const stored = loadStoredCredentials();
    if (stored?.session) await sessionRequest(stored.api_url, "revoke", { token: stored.session.refresh_token });
    deleteCredentials();
  });
}
