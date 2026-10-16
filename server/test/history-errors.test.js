// History asks the dashboard and the API server at once (first good answer wins) and fails with a specific code
// (docs/API-ERRORS.md): agent_offline, timeout, auth_failed, upstream_error.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';

async function hub(t, connection, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-histerr-')), configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: [connection] }));
  const server = await createHub({ configPath, singleUser: true, ...options }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  return async () => { const t0 = performance.now(), r = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/${connection.name}/sessions/sess-1/messages`); return { status: r.status, body: await r.json(), ms: performance.now() - t0 }; };
}
const quiet = (t) => { const warn = console.warn, seen = []; console.warn = (line) => seen.push(String(line)); t.after(() => { console.warn = warn; }); return seen; };
async function closedPort() { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const { port } = s.address(); await new Promise((r) => s.close(r)); return port; }
async function silentPort(t) { const sockets = new Set(), s = net.createServer((c) => { sockets.add(c); c.on('error', () => {}); }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => { for (const c of sockets) c.destroy(); return new Promise((r) => s.close(r)); }); return s.address().port; }

test('history: a slow dashboard no longer delays the answer: the API server, asked in parallel, answers after a 1 s hedge', { timeout: 20_000 }, async (t) => {
  const mock = await mockHermes(t, { beforeDashboardResponse: (req, u) => (/messages$/.test(u.pathname) ? new Promise((r) => setTimeout(r, 4000)) : null) });
  const r = await (await hub(t, mock.connection))();
  assert.equal(r.status, 200); assert.equal(r.body.messages.length, 1); assert.ok(r.ms < 3000, `parallel (${r.ms.toFixed(0)} ms)`);
});

test('history: agent ports refuse -> 502 agent_offline, reason logged', { timeout: 20_000 }, async (t) => {
  const seen = quiet(t), port = await closedPort();
  const r = await (await hub(t, { name: 'gone', host: '127.0.0.1', dashboardPort: port, apiServerPort: port }))();
  assert.equal(r.status, 502); assert.equal(r.body.code, 'agent_offline'); assert.equal(r.body.error, 'The agent is offline');
  const line = JSON.parse(seen.find((l) => l.includes('history.failed'))); assert.equal(line.agent, 'gone'); assert.deepEqual(line.attempts.map((a) => a.code).sort(), ['agent_offline', 'agent_offline']);
});

test('history: both paths hang -> 504 timeout', { timeout: 20_000 }, async (t) => {
  quiet(t); const port = await silentPort(t);
  const r = await (await hub(t, { name: 'slow', host: '127.0.0.1', dashboardPort: port, apiServerPort: port }, { timeoutMs: 400 }))();
  assert.equal(r.status, 504); assert.equal(r.body.code, 'timeout'); assert.ok(r.ms < 3000, `${r.ms.toFixed(0)} ms`);
});

test('history: both paths refuse the hub credentials -> auth_failed (never a 401 to the client)', { timeout: 20_000 }, async (t) => {
  quiet(t); const mock = await mockHermes(t, { rejectProfile: 'default' });
  const r = await (await hub(t, { ...mock.connection, apiServerKey: 'wrong' }))();
  assert.equal(r.status, 502); assert.equal(r.body.code, 'auth_failed');
});

test('history: the agent answers with errors -> upstream_error', { timeout: 20_000 }, async (t) => {
  quiet(t); const mock = await mockHermes(t, { noDashboardMessages: true });
  const broken = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); }); await new Promise((r) => broken.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => broken.close(r)));
  const r = await (await hub(t, { ...mock.connection, apiServerPort: broken.address().port }))();
  assert.equal(r.status, 502); assert.equal(r.body.code, 'upstream_error'); assert.equal(r.body.error, 'The agent could not load this chat');
});
