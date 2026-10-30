// Diagnostic-only consumer proof. Never bundled or published. Synthetic loopback
// API + released MCP bundle + current candidate CLI, using the actual stdio wire.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve('.exit-proof');
mkdirSync(out, { recursive: true });
const cli = resolve('bundle/ideaspaces.js');
const mcp = join(out, 'mcp.mjs');
const home = mkdtempSync(join(tmpdir(), 'exit-mcp-'));
mkdirSync(join(home, '_agent'));
writeFileSync(join(home, '_agent/agreement.md'), '# Agreement\n\nSynthetic proof.\n');
const root = 'n_0123456789abcdef01234567';
const hits = [], rows = [];
const native = /UV_HANDLE_CLOSING|Assertion failed|uv_async_send/;
const server = createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/redirect/auth/me') return res.writeHead(302, { Location: '/catalog' }).end();
  if (req.url === '/denied/auth/me') return res.writeHead(401).end('synthetic denied');
  if (req.url === '/auth/me' || req.url === '/catalog') {
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ username: 'synthetic', repos: [{ repo_id: 'repo_synthetic', root_node_id: root, slug: 'synthetic', name: 'Synthetic', role: 'owner', receipt_classes: ['owner'], actions: ['open', 'clone', 'collaborate'] }] }));
  }
  res.writeHead(404).end('synthetic not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;
const environment = base => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(IS_|IDEASPACES_|CLAUDE|PI_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_USE_ENV_PROXY$|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|GIT_)/i.test(key)) delete env[key];
  return { ...env, HOME: home, USERPROFILE: home, IS_API_URL: base, IS_API_KEY: 'synthetic-loopback-key', IS_CLI_PATH: cli, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
};
async function check(scenario, suffix, expectedError) {
  const child = spawn(process.execPath, [mcp], { cwd: home, env: environment(origin + suffix), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0, buffer = '', stderr = '';
  const pending = new Map();
  let closed = false;
  const closure = new Promise(r => child.once('close', (code, signal) => { closed = true; rejectPending(Error(`MCP closed ${code}/${signal}: ${stderr}`)); r(); }));
  function rejectPending(error) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); }
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  child.stderr.on('data', d => { stderr += d; });
  child.stdout.setEncoding('utf8').on('data', d => {
    buffer += d;
    for (;;) {
      const pos = buffer.indexOf('\n'); if (pos < 0) break;
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const p = pending.get(message.id);
      if (p) { clearTimeout(p.timer); pending.delete(message.id); p.resolve(message); }
    }
  });
  const send = (method, params, notification = false) => {
    if (notification) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); return; }
    return new Promise((resolveResult, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP deadline: ${method}`)); }, 20000);
      pending.set(id, { resolve: resolveResult, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const tool = async (name, args) => {
    const message = await send('tools/call', { name, arguments: args });
    assert(!message.error, JSON.stringify(message));
    const text = message.result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    assert(!native.test(text + stderr), text + stderr);
    return { result: message.result, text };
  };
  try {
    const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'current-exit-proof', version: '1' } });
    assert(!init.error, JSON.stringify(init));
    send('notifications/initialized', {}, true);
    for (let i = 0; i < 5; i++) {
      const listed = await tool('is_spaces', {});
      assert.equal(Boolean(listed.result?.isError), expectedError, listed.text);
      if (!expectedError) assert.equal(JSON.parse(listed.text).repos[0].root_node_id, root);
      else assert(listed.text.length > 0);
      rows.push({ scenario, iteration: i, tool: 'is_spaces', ok: true, isError: expectedError });
      const local = await tool('is_get', { address: home });
      assert(!local.result?.isError, local.text);
      assert.equal(JSON.parse(local.text).logged_in, true);
      rows.push({ scenario, iteration: i, tool: 'subsequent-local-is_get', ok: true });
      if (!expectedError) {
        const remote = await tool('is_get', { address: `${origin}/repos/${root}` });
        assert(!remote.result?.isError, remote.text);
        assert.equal(JSON.parse(remote.text).root_node_id, root);
        rows.push({ scenario, iteration: i, tool: 'remote-is_get', ok: true });
      }
    }
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000);
    try { await closure; } finally { clearTimeout(timer); }
  }
}
try {
  await check('direct', '', false);
  await check('refused-redirect', '/redirect', true);
  await check('unauthorized', '/denied', true);
} finally {
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const report = { node: process.version, uv: process.versions.uv, platform: process.platform, cliSha256: sha(cli), mcpSha256: sha(mcp), rows, hits, limitations: ['Synthetic loopback traffic, not the client account or hosted route.', 'Current main refuses redirects intentionally; ordinary refusal is expected.', 'MCP v0.7.0 package with an explicit fixed CLI override, not a released updated plugin.'] };
  writeFileSync(join(out, 'mcp-summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  rmSync(home, { recursive: true, force: true });
}
