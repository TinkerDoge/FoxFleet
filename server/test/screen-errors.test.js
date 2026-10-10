// Bot Screen failures must be classified so every client can say something actionable instead of showing a blank screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenRelay } from '../screen.js';
import { mockHermes, fakeDashboard } from './fixtures.js';
import { createHub, HUB_INFO, HUB_FEATURES } from '../index.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const m = { name: 'a', host: '127.0.0.1', dashboardPort: 1, profile: 'default' };
const upstream = { dashboard: async () => new Response(JSON.stringify({ ticket: 'gw' }), { status: 200 }) };
const gatewayReturning = (reply) => async () => { const h = {}; return { on: (e, f) => { h[e] = f; }, send: (text) => { const r = JSON.parse(text); setImmediate(() => h.message(JSON.stringify({ jsonrpc: '2.0', id: r.id, ...reply(r) }))); }, close() {} }; };

test('status carries one state word: ok | stopped | no_vnc | not_installed | blocked', async (t) => {
  const states = [[{ supported: true, installed: true, running: true }, 'ok'], [{ supported: true, installed: true, running: false }, 'stopped'], [{ supported: false }, 'no_vnc'], [{ supported: true, installed: false, missing: ['Xvnc', 'xfce4-session'] }, 'not_installed'], [{ supported: true, installed: true, running: false, blocker: 'low memory' }, 'blocked']];
  for (const [result, want] of states) {
    const relay = screenRelay(upstream, { connect: gatewayReturning(() => ({ result })) }); t.after(() => relay.clear());
    const s = await relay.status(m); assert.equal(s.state, want, JSON.stringify(result)); relay.clear();
  }
  const relay = screenRelay(upstream, { connect: gatewayReturning(() => ({ result: { installed: false, missing: ['Xvnc', 7, 'x'.repeat(100)] } })) }); t.after(() => relay.clear());
  assert.deepEqual((await relay.status(m)).missing, ['Xvnc', 'x'.repeat(40)]);
});

test('a Hermes without display.* is "display_unsupported", an unreachable dashboard is "gateway_unreachable", takeover without a session is "reopen"', async (t) => {
  const old = screenRelay(upstream, { connect: gatewayReturning(() => ({ error: { code: -32601, message: 'method not found' } })) }); t.after(() => old.clear());
  await assert.rejects(old.status(m), (e) => e.status === 501 && e.code === 'display_unsupported');
  const refused = screenRelay(upstream, { connect: async () => { throw new Error('ECONNREFUSED'); } }); t.after(() => refused.clear());
  await assert.rejects(refused.status(m), (e) => e.status === 502 && e.code === 'gateway_unreachable');
  const noAuth = screenRelay({ dashboard: async () => new Response('no', { status: 401 }) }, { connect: gatewayReturning(() => ({ result: {} })) }); t.after(() => noAuth.clear());
  await assert.rejects(noAuth.status(m), (e) => e.status === 502 && e.code === 'dashboard_auth');
  const fresh = screenRelay(upstream, { connect: gatewayReturning(() => ({ result: { running: true } })) }); t.after(() => fresh.clear());
  await assert.rejects(fresh.takeover(m), (e) => e.status === 409 && e.code === 'reopen');
});

test('hub: /api/auth lists the hub version and features', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-screen-err-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const mock = await mockHermes(t, { onUpgrade: fakeDashboard([]) });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ machines: [{ ...mock.connection, name: 'bot' }] }));
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = await (await fetch(base + '/api/auth')).json();
  assert.deepEqual(auth.hub, HUB_INFO); assert.match(auth.hub.version, /^\d+\.\d+\.\d+/); for (const f of ['screenErrors', 'media', 'agentActivity']) assert.ok(HUB_FEATURES.includes(f), f);
  assert.equal((await fetch(base + '/api/agents/bot/screen/status')).status, 200);
});
