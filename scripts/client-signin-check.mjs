#!/usr/bin/env node
// Build first. Explicit --sw-space CHECKOUT --python VENV/bin/python. No installed credentials.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadConfig, loadStoredCredentials, saveCredentials } from '../dist/auth/credentials.js';
import { fetchAuthMe } from '../dist/auth/api.js';
const arg = key => process.argv[process.argv.indexOf(key) + 1];
assert(process.argv.includes('--sw-space') && process.argv.includes('--python'), 'Select a local sw_space checkout and its Python explicitly.');
const scratch = await mkdtemp(join(tmpdir(), 'cli-signin-proof-'));
await mkdir(join(scratch, 'home'));
await mkdir(join(scratch, 'bin'));
// A browser boundary stub only: the driver below follows the real local auth redirects.
for (const name of ['open', 'xdg-open']) await writeFile(join(scratch, 'bin', name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
const oldHome = process.env.HOME;
process.env.HOME = join(scratch, 'home');
delete process.env.IS_API_KEY; delete process.env.IS_API_URL;
const child = spawn(resolve(arg('--python')), [fileURLToPath(new URL('./client-signin-server.py', import.meta.url))], {
  cwd: scratch, env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', PYTHONPATH: join(resolve(arg('--sw-space')), 'src') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
try {
  const lines = createInterface({ input: child.stdout });
  const { service, cookie } = await Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)),
    once(child, 'exit').then(() => { throw new Error(`Local fixture failed: ${stderr}`); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Local fixture startup timed out')), 60_000).unref())]);
  const cookies = new Map([['sw_session', cookie]]); // Fresh synthetic test person's web session, private pipe only.
  async function browserGet(url) {
    assert.equal(new URL(url).origin, service);
    const r = await fetch(url, { redirect: 'manual', headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of r.headers.getSetCookie()) { const pair = c.split(';')[0]; const at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
    return r;
  }
  async function browser(url) {
    const u = new URL(url); assert.equal(u.searchParams.get('client'), 'cli');
    let r;
    for (let n = 0; ; n++) {
      try { r = await browserGet(url); break; } catch (e) { if (n > 50) throw e; await new Promise(r => setTimeout(r, 100)); }
    }
    assert.equal(r.status, 302);
    r = await browserGet(new URL(r.headers.get('location'), service));
    assert([302, 307].includes(r.status));
    const providerState = new URL(r.headers.get('location')).searchParams.get('state');
    r = await browserGet(`${service}/auth/google/callback?${new URLSearchParams({ state: providerState, code: 'local-provider-code' })}`);
    assert.equal(r.status, 302);
    const callback = new URL(r.headers.get('location'));
    assert.equal(callback.origin + callback.pathname, u.searchParams.get('redirect_uri'));
    assert.equal(callback.searchParams.get('state'), u.searchParams.get('state'));
    assert.equal((await fetch(callback)).status, 200);
  }
  async function web(path, method = 'GET') {
    const r = await fetch(`${service}${path}`, { method, headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert(r.ok, `Local web-session request failed: ${r.status}`); return r.json();
  }
  async function cliLogin() {
    const cli = spawn(process.execPath, [fileURLToPath(new URL('../bundle/ideaspaces.js', import.meta.url)), 'login'], { env: { HOME: process.env.HOME, PATH: `${join(scratch, 'bin')}:/usr/bin:/bin`, IS_API_URL: service }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', started = false, browserError;
    cli.stdout.on('data', b => { out += b; });
    cli.stderr.on('data', b => {
      err += b;
      const url = err.match(/http:\/\/127\.0\.0\.1:\d+\/auth\/desktop\/authorize\?\S+/)?.[0];
      if (url && !started) { started = true; void browser(url).catch(e => { browserError = e; cli.kill('SIGTERM'); }); }
    });
    const [code] = await once(cli, 'exit');
    if (browserError) throw browserError;
    assert.equal(code, 0, `Bundled CLI login must finish: ${err.replace(/https?:\/\/\S+/g, '<URL>')}`);
    assert(out.includes('Logged in for this CLI install.'));
  }
  async function cliStatus(args = ['status', 'account', '--json']) {
    const cli = spawn(process.execPath, [fileURLToPath(new URL('../bundle/ideaspaces.js', import.meta.url)), ...args], { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; cli.stdout.on('data', b => { out += b; }); cli.stderr.on('data', b => { err += b; });
    const [code] = await once(cli, 'exit'); assert.equal(code, 0, 'Bundled CLI command must exit successfully');
    return JSON.parse(out);
  }
  await cliLogin();
  let config = loadConfig();
  assert.equal((await fetchAuthMe(config)).username, 'one');
  let list = await web('/api/v1/account/desktop-sessions');
  assert.equal(list.sessions.length, 1); assert.equal(list.sessions[0].client, 'cli');
  assert(list.sessions[0].device_name.startsWith('IdeaSpaces CLI on '));
  const installId = list.sessions[0].install_id;
  const old = loadStoredCredentials();
  saveCredentials({ ...old, session: { ...old.session, expires_at: Date.now() } }); // force client pre-expiry refresh, fixture only
  assert.equal((await cliStatus()).logged_in, true);
  const rotated = loadStoredCredentials();
  assert(rotated.session.refresh_token !== old.session.refresh_token, 'Refresh must rotate');
  assert(rotated.api_key !== old.api_key, 'Access must rotate');
  saveCredentials({ ...rotated, session: { ...rotated.session, expires_at: Date.now() } });
  const helper = spawn(process.execPath, [fileURLToPath(new URL('../bundle/ideaspaces.js', import.meta.url)), 'credential', 'get'], { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let credentialOutput = ''; helper.stdout.on('data', b => { credentialOutput += b; }); helper.stderr.resume();
  helper.stdin.end('protocol=https\nhost=git.ideaspaces.localhost\n\n');
  assert.equal((await once(helper, 'exit'))[0], 0);
  const afterGit = loadStoredCredentials();
  assert(afterGit.session.refresh_token !== rotated.session.refresh_token, 'Git helper must refresh before expiry');
  assert(credentialOutput.includes(`password=${afterGit.api_key}\n`), 'Git helper must return the current access token');
  const replay = await fetch(`${service}/auth/desktop/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', install_id: installId, refresh_token: old.session.refresh_token }) });
  assert.equal(replay.status, 400);
  assert.equal((await cliStatus()).logged_in, false); // replay killed the family, not just the consumed token
  assert.equal(loadStoredCredentials(), null);
  await cliLogin();
  assert.equal(loadStoredCredentials().session.install_id, installId);
  list = await web('/api/v1/account/desktop-sessions'); assert.equal(list.sessions.length, 1);
  await web(`/api/v1/account/desktop-sessions/${list.sessions[0].id}`, 'DELETE');
  assert.equal((await cliStatus()).logged_in, false); assert.equal(loadStoredCredentials(), null);
  await cliLogin();
  const beforeLogout = loadConfig();
  assert.equal((await cliStatus(['power', 'logout', '--json'])).logged_out, true); assert.equal(loadStoredCredentials(), null);
  const refused = await fetch(`${service}/auth/me`, { headers: { Authorization: `Bearer ${beforeLogout.apiKey}` } });
  assert.equal(refused.status, 401);
  assert.equal((await web('/api/v1/account/desktop-sessions')).sessions.length, 0);
  console.log(JSON.stringify({ result: 'pass', localOnly: true, realRoutesAndAuth: true, externalProviderOnly: 'fake Google', client: 'cli', webSessionEntry: true, stableInstall: true, bundledCliRefreshRotates: true, gitHelperRefresh: true, replayRevokesFamily: true, webRevocationSignsCliOut: true, serverSignOut: true }));
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  await rm(scratch, { recursive: true, force: true });
}
