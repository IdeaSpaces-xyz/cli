/**
 * Local callback server for OAuth CLI login flow.
 *
 * Starts an HTTP server on a random port, waits for the OAuth callback
 * with the API token, then shuts down.
 */

import { createServer, type Server } from "node:http";
import { URL } from "node:url";

export interface CallbackResult {
  port: number;
  waitForCallback: (timeoutMs?: number) => Promise<string>;
  close: () => void;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>IdeaSpaces — Logged In</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
<div style="text-align: center;">
<h2>Logged in to IdeaSpaces</h2>
<p style="color: #888;">You can close this tab and return to your terminal.</p>
</div>
</body></html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>IdeaSpaces — Error</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa;">
<div style="text-align: center;">
<h2>Login failed</h2>
<p style="color: #888;">No token received. Please try again.</p>
</div>
</body></html>`;

export function startCallbackServer(): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    let tokenResolve: ((token: string) => void) | null = null;
    let tokenReject: ((err: Error) => void) | null = null;

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://127.0.0.1`);

      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");

        if (token) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(SUCCESS_HTML);
          tokenResolve?.(token);
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(ERROR_HTML);
          tokenReject?.(new Error("No token in callback"));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      resolve({
        port: addr.port,
        waitForCallback(timeoutMs = 120_000) {
          return new Promise<string>((res, rej) => {
            tokenResolve = res;
            tokenReject = rej;

            const timer = setTimeout(() => {
              rej(new Error("Login timed out — no callback received within 2 minutes"));
              server.close();
            }, timeoutMs);

            const origResolve = tokenResolve;
            tokenResolve = (token: string) => {
              clearTimeout(timer);
              origResolve(token);
            };
          });
        },
        close() {
          server.close();
        },
      });
    });

    server.on("error", reject);
  });
}
