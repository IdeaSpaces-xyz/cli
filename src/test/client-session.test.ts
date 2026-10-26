import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { cliSignIn } from "../commands/login.js";
import { join } from "node:path";
import { loadConfig, loadStoredCredentials, saveCredentials, withCredentialsLock } from "../auth/credentials.js";
import { cliInstallId, exchangeSignIn, resolveSessionConfig, refuseSession, signOut } from "../auth/client-session.js";
import { fetchAuthMe, streamConversationMessage, optionalAuthRead, getSpaceCopySnapshot } from "../auth/api.js";
const apiUrl = "https://api.test.invalid", config = { apiUrl, apiKey: "old-access", sessionId: "session-one" };
let home: string;
function stored(expires = Date.now() - 1) {
  return { api_url: apiUrl, api_key: "old-access", username: "one", session: { id: "session-one", install_id: "test-install-1", refresh_token: "refresh-one", expires_at: expires, refresh_expires_at: Date.now() + 3600_000 } };
}
const tokenResponse = () => ({ access_token: "new-access", refresh_token: "refresh-two", token_type: "Bearer", expires_in: 3600, refresh_expires_in: 86400, session: { id: "session-one", install_id: "test-install-1", client: "cli" } });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cli-client-session-"));
  vi.stubEnv("HOME", home); vi.stubEnv("IS_API_KEY", ""); vi.stubEnv("IS_API_URL", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
it("keeps a per-service installation across logout, in owner-only files", async () => {
  const a = await withCredentialsLock(async () => cliInstallId(apiUrl));
  expect(await withCredentialsLock(async () => cliInstallId(apiUrl))).toBe(a);
  expect(await withCredentialsLock(async () => cliInstallId("https://other.invalid"))).not.toBe(a);
  saveCredentials(stored());
  if (process.platform !== "win32") expect(statSync(join(home, ".ideaspaces/credentials.json")).mode & 0o777).toBe(0o600);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  await signOut();
  expect(loadConfig()).toBeNull();
  expect(await withCredentialsLock(async () => cliInstallId(apiUrl))).toBe(a);
});
it("stores a PKCE code exchange as a session, never a long-lived key", async () => {
  const fetcher = vi.fn(async () => Response.json(tokenResponse())); vi.stubGlobal("fetch", fetcher);
  await exchangeSignIn(apiUrl, "test-install-1", "one-time-code", "private-verifier", "http://127.0.0.1:12345/callback");
  expect(loadConfig()).toMatchObject({ sessionId: "session-one", apiKey: "new-access" });
  expect(fetcher.mock.calls[0]).toBeDefined();
  const file = readFileSync(join(home, ".ideaspaces/credentials.json"), "utf8");
  expect(file).not.toContain("private-verifier"); expect(file).not.toContain("one-time-code");
});
it("serializes rotations, persists the next refresh atomically and reuses the new access", async () => {
  saveCredentials(stored());
  const fetcher = vi.fn(async () => { expect(loadStoredCredentials()?.session?.refreshing).toBe(true); return Response.json(tokenResponse()); });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([resolveSessionConfig(config), resolveSessionConfig(config)]);
  expect(a.apiKey).toBe("new-access"); expect(b.apiKey).toBe("new-access"); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(loadStoredCredentials()?.session).toMatchObject({ refresh_token: "refresh-two" });
  expect(loadStoredCredentials()?.session?.refreshing).toBeUndefined();
});
it("refreshes HTTP and streaming consumers, and clears only this session on server 401", async () => {
  saveCredentials(stored());
  let tokens = 0;
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/token")) { tokens++; return Response.json(tokenResponse()); }
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer new-access");
    if (url.endsWith("/stream")) return new Response('data: {"type":"done"}\n\n');
    return Response.json({ username: "one" });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await fetchAuthMe(config)).toMatchObject({ username: "one" });
  for await (const event of streamConversationMessage(config, "repo", "chat", { content: "test" } as never)) expect(event.type).toBe("done");
  expect(tokens).toBe(1);
  fetcher.mockImplementation(async () => new Response("revoked", { status: 401 }));
  await expect(fetchAuthMe(config)).rejects.toThrow("401"); expect(loadStoredCredentials()).toBeNull();
});
it("keeps the existing opt-in anonymous public-read fallback when a saved refresh is refused", async () => {
  saveCredentials(stored());
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith("/token")) return new Response("invalid_grant", { status: 400 });
    expect((options.headers as Record<string, string>).Authorization).toBeUndefined();
    return Response.json({ public: true });
  }));
  const read = await optionalAuthRead(config, (c) => getSpaceCopySnapshot(c, "n_test"));
  expect(read.value).toMatchObject({ public: true }); expect(loadStoredCredentials()).toBeNull();
});
it("bounds sign-in even if the browser opener never settles", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(cliSignIn(apiUrl, "Test device", () => new Promise(() => {}), 5)).rejects.toThrow("timed out");
  expect(fetcher).not.toHaveBeenCalled(); expect(loadStoredCredentials()).toBeNull();
});
it("does not replay a refresh after network ambiguity, crashes or malformed token responses", async () => {
  saveCredentials(stored());
  const fetcher = vi.fn().mockRejectedValue(new Error("private-token-network-detail")); vi.stubGlobal("fetch", fetcher);
  await expect(resolveSessionConfig(config)).rejects.toThrow("Check your connection");
  expect(loadStoredCredentials()?.session?.refreshing).toBe(true);
  await expect(resolveSessionConfig(config)).rejects.toThrow("interrupted"); expect(fetcher).toHaveBeenCalledTimes(1);
  saveCredentials(stored()); fetcher.mockResolvedValue(Response.json({ access_token: "incomplete" }));
  await expect(resolveSessionConfig(config)).rejects.toThrow("response was invalid");
  expect(loadStoredCredentials()).toBeNull();
});
it("forgets a terminal invalid_grant, but never falls back to a legacy or env key", async () => {
  saveCredentials(stored()); vi.stubGlobal("fetch", vi.fn(async () => new Response("private error", { status: 400 })));
  await expect(resolveSessionConfig(config)).rejects.toThrow("sign-in ended"); expect(loadStoredCredentials()).toBeNull();
  await expect(resolveSessionConfig(config)).rejects.toThrow("sign-in ended");
});
it("preserves explicit env/legacy credentials and refuses a session service override", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  saveCredentials({ api_url: apiUrl, api_key: "legacy-key" });
  const legacy = loadConfig()!; expect(await resolveSessionConfig(legacy)).toEqual(legacy);
  saveCredentials(stored()); vi.stubEnv("IS_API_URL", "https://other.invalid"); expect(loadConfig()).toBeNull();
  vi.stubEnv("IS_API_KEY", "explicit-key"); const explicit = loadConfig()!;
  expect(explicit).toEqual({ apiUrl: "https://other.invalid", apiKey: "explicit-key" });
  expect(await resolveSessionConfig(explicit)).toEqual(explicit); expect(fetcher).not.toHaveBeenCalled();
});
it("does not erase a newer sign-in when an older request is refused", async () => {
  saveCredentials({ ...stored(), session: { ...stored().session, id: "session-two" } });
  await refuseSession(config); expect(loadStoredCredentials()?.session?.id).toBe("session-two");
});
it("does not delete newly rotated access when a late old-access request returns 401", async () => {
  saveCredentials({ ...stored(), api_key: "rotated-access" });
  await refuseSession(config, "old-access"); expect(loadStoredCredentials()?.api_key).toBe("rotated-access");
});
it("does not roll back a newer sign-in after an interrupted lock owner resumes", async () => {
  saveCredentials(stored());
  vi.stubGlobal("fetch", vi.fn(async () => {
    saveCredentials({ ...stored(), api_key: "new-login-access", session: { ...stored().session, id: "different-session" } });
    return Response.json(tokenResponse());
  }));
  await expect(resolveSessionConfig(config)).rejects.toThrow("changed during refresh");
  expect(loadStoredCredentials()?.api_key).toBe("new-login-access");
});
it("revokes the stored refresh on sign-out, retaining local state on offline failure", async () => {
  saveCredentials(stored());
  const fetcher = vi.fn().mockRejectedValue(new Error("offline")); vi.stubGlobal("fetch", fetcher);
  await expect(signOut()).rejects.toThrow("server sign-out"); expect(loadStoredCredentials()).not.toBeNull();
  fetcher.mockResolvedValue(Response.json({})); await signOut(); expect(loadStoredCredentials()).toBeNull();
  expect(fetcher.mock.calls[1][0]).toBe(`${apiUrl}/auth/desktop/revoke`);
  expect(String(fetcher.mock.calls[1][1].body)).toContain("refresh-one");
});
