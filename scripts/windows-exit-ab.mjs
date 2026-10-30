// Controlled CLI/MCP exit experiment. All authentication is synthetic and all
// requests stay on loopback. Run after prepare-exit-ab.mjs; no production API.
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const artifacts = resolve('.controlled-exit');
const output = resolve(process.env.EXIT_AB_OUTPUT || '.exit-ab-results');
mkdirSync(output, { recursive: true });
const home = mkdtempSync(join(tmpdir(), 'cli-exit-ab-'));
const iterations = Number(process.env.EXIT_AB_ITERATIONS || 20);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw Error('Invalid iteration count');
const runtime = { node: process.version, uv: process.versions.uv, v8: process.versions.v8, platform: process.platform, arch: process.arch, osRelease: (await import('node:os')).release() };
const manifest = JSON.parse(readFileSync(join(artifacts, 'manifest.json'), 'utf8'));
const nativePattern = /UV_HANDLE_CLOSING|Assertion failed:.*handle->flags|uv_async_send/i;
const attempts = [];
const requests = [];
const fixtureRepo = (i) => ({ repo_id: `repo_synthetic_${i}`, slug: `synthetic-${i}`, name: `Synthetic ${i}`, root_node_id: `n_${i.toString(16).padStart(24, '0')}`, role: 'owner', receipt_classes: ['owner'], actions: ['open', 'clone', 'collaborate'] });
const catalog = Buffer.from(JSON.stringify({ username: 'synthetic', repos: Array.from({ length: 30 }, (_, i) => fixtureRepo(i + 1)) }));
const largeCatalog = Buffer.from(JSON.stringify({ username: 'synthetic', repos: Array.from({ length: 30 }, (_, i) => fixtureRepo(i + 1)), ignored_fixture_padding: 'synthetic-body-padding:'.repeat(50000) }));
const compressed = gzipSync(largeCatalog);
const handler = (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  requests.push({ path, method: req.method });
  const [, scenario, attempt, ...tail] = path.split('/');
  const route = '/' + tail.join('/');
  if (scenario === 'probe') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    // Leave body work pending for the upstream-style unread-body positive control.
    res.write(compressed.subarray(0, Math.max(1, Math.floor(compressed.length / 2))));
    const timer = setTimeout(() => { if (!res.destroyed) res.end(compressed.subarray(Math.floor(compressed.length / 2))); }, 25);
    timer.unref();
    return;
  }
  if (route === '/auth/me') {
    if (scenario === 'reset') { req.socket.destroy(); return; }
    if (scenario === 'unauthorized') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('synthetic unauthorized'); return; }
    if (scenario === 'redirect') { res.writeHead(302, { Location: `/${scenario}/${attempt}/redirected` }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', ...(scenario.includes('gzip') ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(scenario.includes('gzip') ? compressed : catalog);
    return;
  }
  if (route === '/redirected') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(catalog); return; }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('synthetic not found');
};
const http = createHttpServer(handler);
await new Promise(r => http.listen(0, '127.0.0.1', r));
const servers = [http];
const bases = { http: `http://localhost:${http.address().port}` };
const certPath = join(artifacts, 'localhost.crt');
if (existsSync(certPath)) {
  const https = createHttpsServer({ key: readFileSync(join(artifacts, 'localhost.key')), cert: readFileSync(certPath) }, handler);
  await new Promise(r => https.listen(0, '127.0.0.1', r));
  servers.push(https);
  bases.https = `https://localhost:${https.address().port}`;
}
function environment(base) {
  // Do not inherit account/API/proxy/Node overrides from the caller.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(IS_|IDEASPACES_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_USE_ENV_PROXY$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)) delete env[key];
  return { ...env, HOME: home, USERPROFILE: home, IS_API_KEY: 'synthetic-loopback-only', IS_API_URL: base, ...(existsSync(certPath) ? { NODE_EXTRA_CA_CERTS: certPath } : {}) };
}
function runProcess(file, args, env, timeoutMs = 12000) {
  return new Promise((resolveResult, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [file, ...args], { env, cwd: home, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, timedOut, ms: Math.round(performance.now() - start), stdout, stderr, nativeAbort: nativePattern.test(stderr) });
    });
  });
}
function record(row) {
  attempts.push(row);
  appendFileSync(join(output, 'attempts.jsonl'), JSON.stringify(row) + '\n');
}
const scenarios = [
  { name: 'http-small', base: bases.http, route: 'small', expected: 0 },
  { name: 'http-gzip-large', base: bases.http, route: 'gzip', expected: 0 },
  { name: 'http-redirect', base: bases.http, route: 'redirect', expected: 0 },
  { name: 'http-401', base: bases.http, route: 'unauthorized', expected: 1 },
  { name: 'http-reset', base: bases.http, route: 'reset', expected: 1 },
  ...(bases.https ? [
    { name: 'https-small', base: bases.https, route: 'small', expected: 0 },
    { name: 'https-gzip-large', base: bases.https, route: 'gzip', expected: 0 },
  ] : []),
];
function verdict(result, expected) {
  let validJson = false;
  try { const value = JSON.parse(result.stdout); validJson = value.username === 'synthetic' && value.repos.length === 30; } catch {}
  const ok = !result.timedOut && !result.nativeAbort && result.code === expected && (expected !== 0 || validJson);
  return { validJson, ok };
}
async function mcpCheck(variant, base) {
  const env = { ...environment(base), IS_CLI_PATH: join(artifacts, `${variant}.mjs`) };
  const child = spawn(process.execPath, [join(artifacts, 'mcp.mjs')], { env, cwd: home, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0, buffer = '', stderr = '';
  const pending = new Map();
  child.stderr.on('data', d => { stderr += d; });
  child.stdout.on('data', d => {
    buffer += d;
    for (;;) {
      const pos = buffer.indexOf('\n');
      if (pos < 0) break;
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const entry = pending.get(message.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message); }
    }
  });
  const rejectPending = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  child.on('error', rejectPending);
  child.on('close', (code, signal) => rejectPending(Error(`MCP exited: ${code}/${signal}; ${stderr}`)));
  child.stdin.on('error', rejectPending);
  function send(method, params, notification = false) {
    if (notification) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); return; }
    return new Promise((resolveResult, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve: resolveResult, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const rows = [];
  try {
    const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'controlled-exit-test', version: '1' } });
    if (init.error) throw Error(JSON.stringify(init.error));
    send('notifications/initialized', {}, true);
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const message = await send('tools/call', { name: 'is_spaces', arguments: {} });
      const result = message.result;
      const text = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || JSON.stringify(message);
      let validJson = false; try { validJson = JSON.parse(text).repos.length === 30; } catch {}
      rows.push({ variant, scenario: 'mcp-is_spaces', iteration: i, ok: !result?.isError && validJson, nativeAbort: nativePattern.test(text), text, ms: Math.round(performance.now() - start) });
      const status = await send('tools/call', { name: 'is_get', arguments: { address: home } });
      let loggedIn = false; try { loggedIn = JSON.parse(status.result.content[0].text).logged_in === true; } catch {}
      rows.push({ variant, scenario: 'mcp-subsequent-is_get', iteration: i, ok: !status.result?.isError && loggedIn, nativeAbort: false, text: JSON.stringify(status.result) });
    }
  } catch (error) {
    rows.push({ variant, scenario: 'mcp-transport', ok: false, nativeAbort: nativePattern.test(stderr), error: String(error), stderr });
  } finally {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(r => { const timer = setTimeout(() => { child.kill(); r(); }, 2000); child.once('close', () => { clearTimeout(timer); r(); }); });
    }
  }
  for (const row of rows) record(row);
}
try {
  // Interleave variants and reverse order on alternate repetitions to reduce drift.
  for (const scenario of scenarios) {
    for (let i = 0; i < iterations; i++) {
      for (const variant of i % 2 ? ['graceful', 'forced'] : ['forced', 'graceful']) {
        const base = `${scenario.base}/${scenario.route}/${i}`;
        const result = await runProcess(join(artifacts, `${variant}.mjs`), ['--json', 'repos'], environment(base));
        record({ variant, scenario: scenario.name, iteration: i, expectedCode: scenario.expected, ...result, ...verdict(result, scenario.expected) });
      }
    }
    console.log('Completed', scenario.name);
  }
  for (const variant of ['forced', 'graceful']) {
    const result = await runProcess(join(artifacts, `${variant}.mjs`), ['--help'], environment(`${bases.http}/small/help`));
    record({ variant, scenario: 'no-network-help', ...result, ok: result.code === 0 && !result.timedOut && !result.nativeAbort });
  }
  // Positive controls are separate from CLI evidence. The CLI consumes bodies;
  // the known upstream-style trigger may leave a response body unread.
  const probe = join(home, 'fetch-exit-probe.mjs');
  writeFileSync(probe, `const r = await fetch(process.argv[2]);\nif (process.argv[3] === 'consumed') await r.text();\nconsole.log(r.status);\nif (process.argv[4] === 'forced') process.exit(0); else process.exitCode = 0;\n`);
  for (const body of ['unread', 'consumed']) {
    for (let i = 0; i < Math.min(iterations, 10); i++) {
      for (const variant of i % 2 ? ['graceful', 'forced'] : ['forced', 'graceful']) {
        const base = `${bases.http}/probe/${i}`;
        const result = await runProcess(probe, [base, body, variant], environment(base));
        record({ variant, scenario: `minimal-fetch-${body}`, iteration: i, ...result, ok: result.code === 0 && !result.timedOut && !result.nativeAbort && result.stdout.trim() === '200' });
      }
    }
  }
  for (const variant of ['forced', 'graceful']) await mcpCheck(variant, `${bases.http}/gzip/mcp`);
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  writeFileSync(join(output, 'requests.json'), JSON.stringify(requests, null, 2) + '\n');
  const groups = {};
  for (const a of attempts) {
    const key = `${a.scenario}/${a.variant}`;
    const g = groups[key] ||= { total: 0, ok: 0, nativeAborts: 0, timeouts: 0, otherFailures: 0, totalMs: 0, exitCodes: {} };
    g.total++; g.ok += Number(a.ok); g.nativeAborts += Number(a.nativeAbort); g.timeouts += Number(Boolean(a.timedOut));
    g.otherFailures += Number(!a.ok && !a.nativeAbort && !a.timedOut); g.totalMs += a.ms || 0;
    if ('code' in a) g.exitCodes[String(a.code)] = (g.exitCodes[String(a.code)] || 0) + 1;
  }
  const cliRows = attempts.filter(a => /^(http|https)-/.test(a.scenario));
  const forced = cliRows.filter(a => a.variant === 'forced');
  const graceful = cliRows.filter(a => a.variant === 'graceful');
  const summary = { runtime, manifest, iterations, requests: requests.length, groups, conclusion: forced.some(a => a.nativeAbort) ? (graceful.some(a => a.nativeAbort) ? 'CLI abort reproduced in both variants; graceful exit is not sufficient.' : 'CLI abort reproduced only with forced exit in this fixture set; graceful exit is supported as a mitigation, not universal proof.') : 'INCONCLUSIVE: exact CLI baseline did not reproduce the native abort on these fixtures. Minimal-fetch controls are separate evidence.', limitations: ['Synthetic loopback traffic, not the client account/API response.', 'Hosted Windows may differ from Windows 11 client build.', 'Passing runs do not prove absence of a timing race.'] };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  // Fail for broken candidates/harness, not for an expected baseline repro.
  if (attempts.some(a => a.timedOut || (!a.ok && (!a.nativeAbort || a.variant === 'graceful')))) process.exitCode = 1;
}
