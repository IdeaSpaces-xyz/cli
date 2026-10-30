import { afterEach, beforeEach, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "./cli-process.js";

let home: string;
let preload: string;
let base: string;
const grants: string[] = [];
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/auth/desktop/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      grants.push(form.get("grant_type")!);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600, refresh_expires_in: 86400,
        session: { id: "synthetic-session", install_id: form.get("install_id"), client: "cli" } }));
    } else if (req.url === "/auth/me") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ username: "synthetic", repos: [] }));
    } else if (req.url === "/auth/desktop/revoke") res.end("{}");
    else res.writeHead(404).end();
  } catch { res.writeHead(500).end(); }
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "cli-exit-lifecycle-"));
  grants.length = 0;
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Loopback fixture did not listen");
  base = `http://127.0.0.1:${address.port}`;
  // No production seams: preload intercepts only OS browser launch and explicit
  // fixture runtime executables; all callbacks, locks, streams and cleanup are real.
  preload = pathToFileURL(join(home, "fixture-preload.mjs")).href;
  writeFileSync(join(home, "fixture-preload.mjs"), `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
const execFile = cp.execFile, spawn = cp.spawn;
cp.execFile = (file, args, ...rest) => {
  if (['open', 'xdg-open', 'rundll32.exe'].includes(basename(file))) {
    const url = new URL(args.at(-1));
    if (url.origin !== ${JSON.stringify(base)}) throw Error('Non-fixture browser URL');
    const callback = new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'synthetic-code');
    const done = rest.at(-1);
    fetch(callback).then(r => r.text()).then(() => done(null, '', ''), done);
    return;
  }
  return execFile(file, args, ...rest);
};
cp.spawn = (file, args, options) => {
  if (file === 'exit-fixture-claude' || file === 'exit-fixture-pi') {
    return spawn(process.execPath, [fileURLToPath(new URL('./fixture-runtime.cjs', import.meta.url)), file, ...args], options);
  }
  if (/^(claude|pi)(\\.exe|\\.cmd)?$/.test(basename(file))) throw Error('Real model runtimes forbidden in this test');
  return spawn(file, args, options);
};
syncBuiltinESMExports();
`);
  writeFileSync(join(home, "fixture-runtime.cjs"), `
require('node:fs').writeFileSync(${JSON.stringify(join(home, "runtime.pid"))}, String(process.pid));
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
// Persistent backends must be stopped by the CLI, not by process.exit().
setInterval(() => {}, 1000);
if (process.argv[2] === 'exit-fixture-claude') {
  let prompt = '';
  process.stdin.on('data', d => { prompt += d; });
  process.stdin.on('end', () => {
    out({ type: 'system', subtype: 'init', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', model: 'synthetic', cwd: process.cwd() });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'synthetic completion', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  });
} else {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const command = JSON.parse(line);
    if (command.type === 'get_state') out({ type: 'response', command: 'get_state', success: true, data: { sessionName: 'Synthetic' } });
    if (command.type === 'prompt') {
      out({ type: 'agent_start' }); out({ type: 'turn_start' });
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'synthetic completion' } });
      out({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });
    }
  });
}
`);
});
afterEach(async () => {
  const pidFile = join(home, "runtime.pid");
  if (existsSync(pidFile)) {
    // Cleanup only the synthetic backend created by this test if a regression
    // left it running after the parent deadline killed the CLI.
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* already stopped */ }
  }
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

it("naturally completes browser login, credential refresh and logout without lingering callback/lock handles", async () => {
  const options = { home, preload, env: { IS_API_URL: base } };
  const login = await runCli(["--json", "login"], options);
  expect(login, login.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
  expect(JSON.parse(login.stdout).logged_in).toBe(true);
  const file = join(home, ".ideaspaces/credentials.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.session.expires_at = 0;
  writeFileSync(file, JSON.stringify(stored));
  const credential = await runCli(["credential", "get"], { ...options, stdin: "protocol=https\nhost=git.ideaspaces.xyz\n\n" });
  expect(credential, credential.stderr).toMatchObject({ code: 0, signal: null, timedOut: false, stdout: "username=token\npassword=synthetic-access\n\n" });
  expect(grants).toEqual(["authorization_code", "refresh_token"]);
  expect(existsSync(file + ".lock")).toBe(false);
  const logout = await runCli(["--json", "power", "logout"], options);
  expect(logout, logout.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
  expect(existsSync(file)).toBe(false);
}, 60_000);

it.each(["claude", "pi"])("agent run with a persistent synthetic %s backend completes without leaving the CLI alive", async runtime => {
  mkdirSync(join(home, "_agent"));
  writeFileSync(join(home, "_agent/agreement.md"), "---\nname: Synthetic agent\n---\n# Agreement\n");
  const extension = join(home, "extension.ts");
  writeFileSync(extension, "export default () => {};\n");
  const result = await runCli(["--json", "agent", "run", home, "--runtime", runtime, "--message", "synthetic test", `--${runtime}-bin`, `exit-fixture-${runtime}`,
    ...(runtime === "pi" ? ["--ext", extension] : [])], { home, preload });
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null, timedOut: false });
  const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(events.some(e => e.type === "turn_complete")).toBe(true);
  const pid = Number(readFileSync(join(home, "runtime.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}, 20_000);
