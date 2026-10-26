/** One-use IPv4 loopback callback for a state-bound PKCE authorization code, never a token. */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface CallbackResult {
  port: number;
  waitForCallback: (timeoutMs?: number) => Promise<string>;
  close: () => void;
}
const HTML = '<!doctype html><meta charset="utf-8"><title>IdeaSpaces sign-in</title><h2>Sign-in code received</h2><p>Return to your terminal to finish signing in. You can close this tab.</p>';
function matches(actual: string | null, expected: string): boolean {
  if (!actual || actual.length > 1024) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function startCallbackServer(expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let accept!: (code: string) => void;
    let refuse!: (error: Error) => void;
    const result = new Promise<string>((res, rej) => { accept = res; refuse = rej; });
    // A callback can arrive before waitForCallback is installed (browser fast path).
    void result.catch(() => undefined);
    const fail = (message: string) => { if (!settled) { settled = true; clearTimeout(timer); refuse(new Error(message)); } };
    const server = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const address = server.address();
      const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
      if (req.method !== "GET" || req.headers.host !== host || (req.url?.length ?? 0) > 8192) { res.writeHead(400).end("Invalid callback"); return; }
      const url = new URL(req.url || "/", `http://${host}`);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      if (settled || url.searchParams.getAll("state").length !== 1 || !matches(url.searchParams.get("state"), expectedState)) {
        res.writeHead(400).end("Invalid or expired sign-in state. Return to your terminal."); return;
      }
      if (url.searchParams.has("error")) {
        res.writeHead(400).end("Sign-in was not approved. Return to your terminal.");
        fail("Sign-in was not approved. Run `ideaspaces login` to try again."); return;
      }
      const code = url.searchParams.get("code");
      if (!code || code.length > 2048 || url.searchParams.getAll("code").length !== 1 || url.searchParams.has("token")) {
        res.writeHead(400).end("No valid authorization code received."); return;
      }
      settled = true; clearTimeout(timer);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(HTML);
      accept(code);
    });
    server.on("error", (error) => { fail("The local sign-in callback failed. Run `ideaspaces login` again."); reject(error); });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not open the local sign-in callback.")); return; }
      resolve({ port: address.port,
        waitForCallback(timeoutMs = 120_000) {
          if (!settled && !timer) timer = setTimeout(() => { fail("Sign-in timed out. Run `ideaspaces login` to try again."); server.close(); }, timeoutMs);
          return result;
        },
        close() { fail("The sign-in callback closed before completion."); server.close(); server.closeAllConnections(); },
      });
    });
  });
}
