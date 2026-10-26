import { execFile } from "node:child_process";
import { hostname, platform } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { getDefaultApiUrl, withCredentialsLock, loadStoredCredentials } from "../auth/credentials.js";
import { cliInstallId, exchangeSignIn, cacheSessionUsername, serviceOrigin, SessionAuthError } from "../auth/client-session.js";
import { startCallbackServer } from "../auth/callback-server.js";
import { registerGitCredentialHelper } from "../auth/git-credential-helper.js";
import { createOutput } from "../output.js";
import { deriveWebBase, fetchAuthMe, UnauthorizedError } from "../auth/api.js";
import type { CommandDef } from "../types.js";

export interface CliSignInRequest { port: number; state: string; challenge: string; installId: string; deviceName: string }
export function buildCliLoginUrl(apiUrl: string, request: CliSignInRequest): string {
  const url = new URL("/auth/desktop/authorize", serviceOrigin(apiUrl));
  for (const [key, value] of Object.entries({ client: "cli", redirect_uri: `http://127.0.0.1:${request.port}/callback`,
    state: request.state, code_challenge: request.challenge, code_challenge_method: "S256", install_id: request.installId, device_name: request.deviceName })) url.searchParams.set(key, value);
  return url.toString();
}
/** No shell interpolation, including on Windows. */
export function openBrowser(url: string): Promise<void> {
  const [command, args] = platform() === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : platform() === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve, reject) => execFile(command, args, (error) => error ? reject(new Error("Could not open a browser. Open the sign-in URL manually.")) : resolve()));
}

/** Same flow for the command and the opt-in local proof. The browser seam never receives secrets. */
export async function cliSignIn(apiUrl: string, deviceName: string, browser: (url: string) => Promise<void>, timeoutMs = 120_000) {
  apiUrl = serviceOrigin(apiUrl);
  const installId = await withCredentialsLock(async () => cliInstallId(apiUrl));
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = await startCallbackServer(state);
  try {
    const code = callback.waitForCallback(timeoutMs);
    // Start waiting before opening the browser; retain even an immediate loopback response.
    const opened = browser(buildCliLoginUrl(apiUrl, { port: callback.port, state, challenge, installId, deviceName })).then(() => code);
    const authCode = await Promise.race([code, opened]);
    return await exchangeSignIn(apiUrl, installId, authCode, verifier, `http://127.0.0.1:${callback.port}/callback`);
  } finally { callback.close(); }
}

export const loginCommand: CommandDef = {
  name: "login",
  description: "Log in to IdeaSpaces (optional — required for sync)",
  usage: "ideaspaces login",
  examples: ["ideaspaces login              # Browser sign-in for this CLI install; saves a rotating session"],
  async run(_args, _flags, global) {
    const output = createOutput(global);
    const apiUrl = getDefaultApiUrl();
    try {
      const replacing = !!loadStoredCredentials();
      if (replacing) output.progress("Signing in replaces the saved CLI credential. Existing API keys are not revoked. Use `ideaspaces power logout` first when switching accounts/services if you need the old session revoked.");
      const stored = await cliSignIn(apiUrl, `IdeaSpaces CLI on ${hostname()}`.slice(0, 128), async (url) => {
        output.progress(`Opening browser for sign-in...\n${url}`);
        try { await openBrowser(url); } catch { output.progress("Could not open the browser. Open the URL above manually; this terminal is still waiting."); }
      });
      const config = { apiUrl: stored.api_url, apiKey: stored.api_key, sessionId: stored.session!.id };
      try {
        const me = await fetchAuthMe(config);
        if (me.username) await cacheSessionUsername(config, me.username);
      } catch (error) { if (error instanceof UnauthorizedError || error instanceof SessionAuthError) throw error; /* handle lookup may be temporarily offline */ }
      await registerGitCredentialHelper();
      const explicit = !!process.env.IS_API_KEY;
      if (explicit) output.progress("IS_API_KEY is set and still overrides the saved session. Unset it to use this sign-in.");
      const webUrl = deriveWebBase(apiUrl);
      output.result({ logged_in: true, web_url: webUrl, ...(replacing ? { replaced_stored_credential: true } : {}), ...(explicit ? { env_override_active: true } : {}) }, `Logged in for this CLI install.\nView your account: ${webUrl}\nGit push/pull uses the session automatically. Manage or revoke this install in web Desktop sign-ins.`);
      return 0;
    } catch (error) {
      output.error(error instanceof Error ? error.message : "Sign-in failed. Run `ideaspaces login` again.");
      return 1;
    }
  },
};
