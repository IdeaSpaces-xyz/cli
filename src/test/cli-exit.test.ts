import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli, type CliProcessResult } from "./cli-process.js";

// Deliberately exercise the built entry, not CommandDef.run: only the entry owns
// exit. npm ci/build prepares the bundle. All traffic and credentials are local.
// The checked-in TLS key/cert are public loopback fixtures, never credentials.
const tlsFixture = resolve("src/test/fixtures/loopback-tls");
const certificate = join(tlsFixture, "cert.pem");
const rootId = "n_0123456789abcdef01234567";
const catalog = { username: "synthetic", repos: [{
  repo_id: "repo_synthetic", slug: "synthetic", name: "Synthetic",
  root_node_id: rootId, role: "owner", receipt_classes: ["owner"],
  actions: ["open", "clone", "collaborate"],
}] };

function expectExit(result: CliProcessResult, code = 0): void {
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.signal, result.stderr).toBeNull();
  expect(result.stderr).not.toMatch(/UV_HANDLE_CLOSING|Assertion failed|uv_async_send/);
  expect(result.code, result.stderr).toBe(code);
}

describe("bundled CLI command completion", () => {
  let home: string;
  let httpUrl: string;
  let httpsUrl: string;
  const hits: Record<"http" | "https", string[]> = { http: [], https: [] };
  const handler = (req: IncomingMessage, res: ServerResponse, requests: string[]) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    requests.push(path);
    if (path === "/redirect/auth/me") {
      res.writeHead(302, { Location: "/redirect/catalog" }).end();
    } else if (path === "/denied/auth/me") {
      res.writeHead(401).end("synthetic unauthorized");
    } else if (path === "/reset/auth/me") {
      req.socket!.destroy();
    } else if (path === "/throw/auth/me") {
      // JSON is valid but projection throws outside the command's request catch.
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ repos: null }));
    } else if (path === "/invalid/auth/me") {
      res.writeHead(200, { "Content-Type": "application/json" }).end("not JSON");
    } else if (path.endsWith("/auth/me") || path.endsWith("/catalog")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(catalog));
    } else {
      // A private source read may 404; the account catalog still allows cloning.
      res.writeHead(404).end("synthetic not found");
    }
  };
  const http = createServer((req, res) => handler(req, res, hits.http));
  const https = createHttpsServer({ key: readFileSync(join(tlsFixture, "key.pem")), cert: readFileSync(certificate) }, (req, res) => handler(req, res, hits.https));
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "cli-exit-"));
    await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
    await new Promise<void>(r => https.listen(0, "127.0.0.1", r));
    const address = http.address(), secure = https.address();
    if (!address || typeof address === "string" || !secure || typeof secure === "string") throw Error("Loopback fixture did not listen");
    httpUrl = `http://127.0.0.1:${address.port}`;
    httpsUrl = `https://127.0.0.1:${secure.port}`;
  });
  afterAll(async () => {
    for (const server of [http, https]) {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }
    if (home) rmSync(home, { recursive: true, force: true });
  });
  const env = (base: string) => ({ IS_API_URL: base, IS_API_KEY: "synthetic-loopback-key", NODE_EXTRA_CA_CERTS: certificate });

  it.each(["http", "https"] as const)("refuses %s redirects with an ordinary error, never a native abort", async protocol => {
    const base = protocol === "https" ? httpsUrl : httpUrl;
    const before = hits[protocol].length;
    for (let i = 0; i < 5; i++) {
      const result = await runCli(["--json", "repos"], { home, env: env(`${base}/redirect`) });
      // Current auth intentionally uses redirect:error. Do not relax that policy
      // to reproduce the older CLI's followed-redirect failure. Both successful
      // reads and refused fetches must finish without racing native teardown.
      expectExit(result, 1);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    // Prove each HTTPS request reached the TLS server: a trust/handshake error
    // also exits 1, and must not pass by reusing the HTTP test's request history.
    expect(hits[protocol].slice(before)).toEqual(Array(5).fill("/redirect/auth/me"));
  }, 90_000);

  it.each(["http", "https"] as const)("returns complete JSON after an authenticated %s read", async protocol => {
    const before = hits[protocol].length;
    const result = await runCli(["--json", "repos"], { home, env: env(protocol === "https" ? httpsUrl : httpUrl) });
    expectExit(result);
    expect(JSON.parse(result.stdout)).toMatchObject({ username: "synthetic", repos: [{ root_node_id: rootId }] });
    expect(hits[protocol].slice(before)).toEqual(["/auth/me"]);
  }, 20_000);

  it("allows runtime beforeExit completion on success, returned errors and thrown errors", async () => {
    const marker = join(home, "completion-observed");
    const observer = join(home, "completion-observer.mjs");
    // A test-only observer, not a replacement fetch or production exit hook.
    // This detects forced exits even where Node/auth hardening no longer
    // reproduces the historical native abort on the same redirect fixture.
    writeFileSync(observer, `import { writeFileSync } from 'node:fs';\nprocess.once('beforeExit', code => writeFileSync(${JSON.stringify(marker)}, String(code)));\n`);
    for (const [suffix, code] of [["", 0], ["/denied", 1], ["/throw", 1]] as const) {
      rmSync(marker, { force: true });
      const result = await runCli(["--json", "repos"], { home, env: env(httpUrl + suffix), preload: pathToFileURL(observer).href });
      expectExit(result, code);
      expect(readFileSync(marker, "utf8")).toBe(String(code));
    }
  }, 45_000);

  it("preserves returned-error and thrown-error exit statuses after network I/O", async () => {
    for (const scenario of ["denied", "invalid", "throw", "reset"]) {
      const result = await runCli(["--json", "repos"], { home, env: env(`${httpUrl}/${scenario}`) });
      expectExit(result, 1);
      expect(result.stdout).toBe("");
      expect(result.stderr.length).toBeGreaterThan(0);
      if (scenario === "denied") expect(result.stderr).toMatch(/Session expired/);
      if (scenario === "throw") expect(result.stderr).toMatch(/^Error:/);
      expect(hits.http).toContain(`/${scenario}/auth/me`);
    }
  }, 45_000);

  it("completes known-URL planning after the catalog and private-source reads", async () => {
    const result = await runCli(["--json", "get", `${httpUrl}/repos/${rootId}`], { home, env: env(httpUrl) });
    expectExit(result);
    expect(JSON.parse(result.stdout)).toMatchObject({ root_node_id: rootId, logged_in: true, modes: { clone: { available: true } } });
  }, 20_000);

  it("keeps output larger than a pipe buffer complete", async () => {
    mkdirSync(join(home, "_agent"), { recursive: true });
    writeFileSync(join(home, "_agent/agreement.md"), "# Agreement\n");
    const body = "complete-output-marker ".repeat(10000);
    writeFileSync(join(home, "large.md"), `---\nname: Large note\n---\n${body}`);
    const result = await runCli(["--json", "look", "large.md", "--depth", "full"], { home });
    expectExit(result);
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    expect(JSON.stringify(JSON.parse(result.stdout))).toContain(body);
  }, 20_000);

  it("retains help and unknown-command early exits", async () => {
    expectExit(await runCli(["--help"], { home }));
    expectExit(await runCli(["not-a-command"], { home }), 1);
  }, 30_000);
});
