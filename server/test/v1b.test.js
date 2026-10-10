// v1-b: screen takeover through the reverse connector (WebSocket tunnelling), admin routes used by the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes, fakeDashboard, rawClient } from './fixtures.js';
import { createHub } from '../index.js';
import { encodeFrame } from '../ws.js';
import { fakeHermesHome, runConnector, tmpDir, waitFor } from './machine-helpers.js';

async function hub(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-v1b-'));
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true, ...options }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 20)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const call = (route, data, method = data === undefined ? 'GET' : 'POST') => fetch(base + route, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { base, call };
}

test('screen takeover works through the connector: tickets, RFB splice, lease, hand-back', async (t) => {
  const log = [], mock = await mockHermes(t, { onUpgrade: fakeDashboard(log) });
  const { base, call } = await hub(t);
  const root = await fakeHermesHome(t, mock, { profiles: [] }), cfgDir = await tmpDir(); const pr = runConnector(t, ['pair', '--hub', base, '--code', (await (await call('/api/machines/pairing', {})).json()).code, '--all', '--dashboard-port', String(mock.connection.dashboardPort)], { hermes: root, configDir: cfgDir });
  let a = await waitFor(async () => { const x = (await (await call('/api/agents')).json()).agents.find((g) => g.name === 'default'); return x?.online ? x : null; }); assert.ok(a, pr.out);
  assert.equal(a.capabilities.screen, true);
  const status = await (await call('/api/agents/default/screen/status')).json(); assert.equal(status.running, true); assert.equal(status.lease.holder, 'agent');
  assert.equal((await call('/api/agents/default/screen/takeover', {})).status, 409);
  const obs = await (await call('/api/agents/default/screen/observe', {})).json();
  assert.match(obs.ticket, /^[A-Za-z0-9_-]{32}$/); assert.ok(!JSON.stringify(obs).includes('display-ticket-1'));
  const gw = log.find((x) => x.path === '/api/ws'); assert.equal(gw.origin, `http://127.0.0.1:${mock.connection.dashboardPort}`, 'origin rewritten to the local dashboard');
  assert.equal((await rawClient(base, `/api/agents/default/screen/ws?ticket=${obs.ticket}`, {})).status, 403, 'no Origin');
  const obs2 = await (await call('/api/agents/default/screen/observe', {})).json();
  const ok = await rawClient(base, `/api/agents/default/screen/ws?ticket=${obs2.ticket}`, { Origin: base });
  assert.equal(ok.status, 101); assert.equal(ok.accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  ok.socket.write(encodeFrame(2, Buffer.from('key-down'), true)); await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(ok.frames.map((f) => f.data.toString()), ['RFB 003.008\n', 'echo:key-down']);
  assert.equal((await rawClient(base, `/api/agents/default/screen/ws?ticket=${obs2.ticket}`, { Origin: base })).status, 403, 'single use');
  const obs3 = await (await call('/api/agents/default/screen/observe', {})).json();
  const app = await rawClient(base, `/api/agents/default/screen/ws?ticket=${obs3.ticket}`, { Origin: 'https://appassets.androidplatform.net' }); assert.equal(app.status, 101); app.socket.destroy();
  const take = await (await call('/api/agents/default/screen/takeover', {})).json(); assert.equal(take.lease.holder, 'human'); assert.ok(take.autoHandBackAt > Date.now());
  const back = await (await call('/api/agents/default/screen/handback', {})).json(); assert.equal(back.lease.holder, 'agent');
  ok.socket.destroy();
  const bad = await rawClient(base, `/api/agents/default/screen/ws?ticket=nope`, { Origin: base }); assert.equal(bad.status, 403);
});

test('screen route refuses when the machine is offline (no stale ports)', async (t) => {
  const mock = await mockHermes(t), { base, call } = await hub(t), root = await fakeHermesHome(t, mock, { profiles: [] });
  const pr = runConnector(t, ['pair', '--hub', base, '--code', (await (await call('/api/machines/pairing', {})).json()).code, '--all', '--dashboard-port', String(mock.connection.dashboardPort)], { hermes: root, configDir: await tmpDir() });
  assert.ok(await waitFor(async () => (await (await call('/api/agents')).json()).agents.length), pr.out); pr.p.kill();
  await waitFor(async () => !(await (await call('/api/agents')).json()).agents[0].online);
  const r = await call('/api/agents/default/screen/status'); assert.ok([502, 409, 404].includes(r.status), String(r.status));
});

import { qrMatrix, qrSvg } from '../qr.js';
test('qr: structure is valid (finders, timing, size by version) and long text is refused', () => {
  const m = qrMatrix('foxfleet://connect?hub=https://hub.example.com'); assert.equal(m.length, 29);
  for (const [r, c] of [[0, 0], [0, 22], [22, 0]]) { assert.equal(m[r][c], true); assert.equal(m[r + 3][c + 3], true); assert.equal(m[r + 1][c + 1], false); }
  for (let i = 8; i < 21; i++) assert.equal(m[6][i], i % 2 === 0);
  assert.equal(qrMatrix('hi').length, 21); assert.throws(() => qrMatrix('x'.repeat(120)), /too long/);
  assert.match(qrSvg('hi'), /^<svg /);
});

test('admin: pairing link, invite link, user disable signs the user out', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-adm-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const server = await createHub({ configPath: path.join(dir, 'config.json') }); await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { token, data, method = data === undefined ? 'GET' : 'POST' } = {}) => fetch(base + route, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const o = (await (await call('/api/auth/setup', { data: { username: 'owner1', password: 'correct horse battery', client: 'app' } })).json()).token;
  const pair = await (await call('/api/admin/pairing', { token: o })).json(); assert.equal(pair.link, `foxfleet://connect?hub=${base}`); assert.match(pair.svg, /<svg/); assert.equal(pair.rows.length, 29); assert.match(pair.rows[0], /^1111111/);
  assert.equal((await fetch(base + '/pair', { redirect: 'manual' })).status, 302);
  assert.match(await (await call('/pair', { token: o })).text(), /Pair a phone/);
  await call('/api/admin/settings', { token: o, data: { registration: 'invite' }, method: 'PUT' });
  const inv = await (await call('/api/admin/invites', { token: o, data: {} })).json(); assert.equal(inv.link, `foxfleet://connect?hub=${base}&invite=${inv.code}`); assert.ok(inv.rows.length >= 29);
  const alice = await (await call('/api/auth/register', { data: { username: 'alice', password: 'correct horse battery', invite: inv.code, client: 'app' } })).json();
  const users = (await (await call('/api/admin/users', { token: o })).json()).users; const a = users.find((u) => u.username === 'alice'); assert.equal(a.disabled, false);
  assert.equal((await call('/api/connections', { token: alice.token })).status, 200);
  assert.equal((await call(`/api/admin/users/${a.id}`, { token: o, method: 'PATCH', data: { disabled: true } })).status, 200);
  assert.equal((await call('/api/connections', { token: alice.token })).status, 401);
  assert.equal((await call('/api/auth/login', { data: { username: 'alice', password: 'correct horse battery' } })).status, 403);
  assert.equal((await call(`/api/admin/users/${users.find((u) => u.role === 'owner').id}`, { token: o, method: 'PATCH', data: { disabled: true } })).status, 400);
  assert.equal((await call(`/api/admin/users/${a.id}`, { token: alice.token, method: 'PATCH', data: { disabled: false } })).status, 401);
  assert.equal((await call(`/api/admin/users/${a.id}`, { token: o, method: 'PATCH', data: { disabled: false } })).status, 200);
  assert.equal((await call('/api/auth/login', { data: { username: 'alice', password: 'correct horse battery' } })).status, 200);
});
