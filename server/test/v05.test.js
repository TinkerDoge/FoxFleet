// v0.5: data-driven agent registry (kinds, schemas, write-only secrets, order, migration) and the
// privacy contract: nothing the hub returns to clients names a host, IP, port or URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';

async function setup(t, raw) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-v05-')), configPath = path.join(dir, 'config.json');
  if (raw) await writeFile(configPath, JSON.stringify(raw));
  const server = await createHub({ configPath, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 20)); await rm(dir, { recursive: true, force: true }); });
  const request = (route, data, method = 'GET') => fetch(base + route, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { request, configPath, dir };
}

// IPv4, IPv6-ish, any URL scheme, host:port, internal hostnames used on the studio network.
const LEAKS = [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, /\b[a-z][a-z0-9+.-]*:\/\//i, /\[[0-9a-f:]+\]/i, /\b[\w.-]+:\d{2,5}\b/, /\bbox-\d+\b/i, /\blocalhost\b/i, /\.(?:lan|local|internal)\b/i];
function assertNoLeaks(label, body) {
  const text = JSON.stringify(body);
  for (const re of LEAKS) assert.doesNotMatch(text, re, `${label} leaks ${re}: ${text.slice(0, 400)}`);
}

test('privacy: agent and connection lists, detail, kinds and test results contain no IP, URL or host:port', async (t) => {
  const mock = await mockHermes(t);
  const { request } = await setup(t, { version: 2, machines: [{ ...mock.connection, name: 'Atlas', dashboardUrl: 'https://box-01.lan:9443', uploadDir: '/home/atlas/up', description: 'Studio lead' }] });
  const glm = await request('/api/connections', { name: 'GLM', kind: 'openai', baseUrl: 'http://192.0.2.10:8080/v1', model: 'glm-5.3', apiKey: 'sk-secret-value-123456' }, 'POST');
  assert.equal(glm.status, 201); const created = await glm.json(); assertNoLeaks('create', created); assert.equal(created.connection.hasBaseUrl, true);
  const muse = await (await request('/api/connections', { name: 'Scribe', kind: 'mcp-inbox', label: 'Scribe' }, 'POST')).json();
  assert.equal(typeof muse.inboxToken, 'string'); assertNoLeaks('inbox create', muse);
  const agents = await (await request('/api/agents')).json(); assertNoLeaks('/api/agents', agents);
  for (const a of agents.agents) {
    assert.deepEqual(Object.keys(a).filter((k) => !['id', 'name', 'displayName', 'kind', 'order', 'description', 'avatar', 'status', 'online', 'chatReady', 'managementReady', 'capabilities', 'activeSessions', 'lastSeen', 'checks'].includes(k)), [], a.name);
    for (const k of ['host', 'profile', 'baseUrl', 'dashboardPort', 'apiServerPort', 'dashboardUrl', 'apiServerUrl', 'uploadDir', 'model', 'version']) assert.equal(a[k], undefined, `${a.name}.${k}`);
  }
  assert.deepEqual(agents.agents.map((a) => a.kind), ['hermes', 'openai', 'mcp-inbox']);
  assertNoLeaks('/api/agents?bridged=1', await (await request('/api/agents?bridged=1')).json());
  assertNoLeaks('/api/agents/Atlas', await (await request('/api/agents/Atlas')).json());
  const connections = await (await request('/api/connections')).json(); assertNoLeaks('/api/connections', connections);
  assert.ok(!JSON.stringify(connections).includes('sk-secret-value') && !JSON.stringify(connections).includes('/home/atlas'));
  assertNoLeaks('/api/agent-kinds', await (await request('/api/agent-kinds')).json());
  assertNoLeaks('saved test', await (await request('/api/connections/Atlas/test', {}, 'POST')).json());
  assertNoLeaks('draft test', await (await request('/api/connections/test', { name: 'Draft', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'x' }, 'POST')).json());
  assertNoLeaks('edit', await (await request('/api/connections/Atlas', { description: 'Lead' }, 'PUT')).json());
});

test('registry: kinds expose schemas; planned kinds are listed but rejected', async (t) => {
  const { request } = await setup(t);
  const { kinds } = await (await request('/api/agent-kinds')).json();
  assert.deepEqual(kinds.map((k) => k.kind), ['hermes', 'openai', 'openrouter', 'zai', 'opencode', 'grok', 'mcp-inbox', 'a2a', 'webhook']);
  const hermes = kinds.find((k) => k.kind === 'hermes');
  assert.equal(hermes.fields.find((f) => f.key === 'host').writeOnly, true); assert.equal(hermes.fields.find((f) => f.key === 'dashboardPass').writeOnly, true);
  assert.equal(hermes.fields.find((f) => f.key === 'profile').writeOnly, false); assert.equal(hermes.capabilities.screen, true);
  assert.equal(kinds.find((k) => k.kind === 'a2a').planned, true);
  const r = await request('/api/connections', { name: 'x', kind: 'a2a' }, 'POST'); assert.equal(r.status, 400); assert.match((await r.json()).error, /not available yet/);
});

test('registry: blank write-only fields keep saved values; secrets never round-trip', async (t) => {
  const { request, configPath } = await setup(t);
  assert.equal((await request('/api/connections', { name: 'desk', host: '192.168.1.10', dashboardPass: 'pw', apiServerKey: 'key', uploadDir: '/srv/up', description: 'Desk agent', avatar: 'fox' }, 'POST')).status, 201);
  const edit = await (await request('/api/connections/desk', { host: '', dashboardPort: null, dashboardPass: '', apiServerKey: '', uploadDir: '', label: 'Desk' }, 'PUT')).json();
  assert.equal(edit.connection.label, 'Desk'); assert.equal(edit.connection.hasHost, true); assert.equal(edit.connection.hasDashboardPass, true); assert.equal(edit.connection.description, 'Desk agent');
  const stored = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(stored.version, 3); const m = stored.machines[0];
  assert.equal(m.host, '192.168.1.10'); assert.equal(m.dashboardPort, 9119); assert.equal(m.dashboardPass, 'pw'); assert.equal(m.apiServerKey, 'key'); assert.equal(m.uploadDir, '/srv/up');
  assert.equal((await request('/api/connections/desk', { host: '10.0.0.2' }, 'PUT')).status, 200);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).machines[0].host, '10.0.0.2');
  assert.equal((await request('/api/connections/desk', { description: 'x'.repeat(281) }, 'PUT')).status, 400);
});

test('registry: reorder lists every agent once and drives /api/agents order', async (t) => {
  const { request } = await setup(t);
  for (const name of ['a', 'b', 'c']) assert.equal((await request('/api/connections', { name, kind: 'mcp-inbox' }, 'POST')).status, 201);
  assert.equal((await request('/api/connections/order', { names: ['c', 'a'] }, 'POST')).status, 400);
  assert.equal((await request('/api/connections/order', { names: ['c', 'a', 'a'] }, 'POST')).status, 400);
  assert.deepEqual((await (await request('/api/connections/order', { names: ['c', 'a', 'b'] }, 'POST')).json()).order, ['c', 'a', 'b']);
  const agents = (await (await request('/api/agents')).json()).agents; assert.deepEqual(agents.map((a) => [a.id, a.order]), [['c', 0], ['a', 1], ['b', 2]]);
  assert.equal((await request('/api/connections/a', undefined, 'DELETE')).status, 200);
  assert.deepEqual((await (await request('/api/connections')).json()).connections.map((c) => c.name), ['c', 'b']);
});

test('migration: v1 config is backed up and versioned', async (t) => {
  const v1 = { machines: [{ name: 'Orion', host: 'box-01.invalid', profile: 'default', dashboardPass: 'pw' }, { name: 'Other', host: '10.0.0.3' }] };
  const { request, configPath } = await setup(t, v1);
  assert.deepEqual(JSON.parse(await readFile(configPath + '.v1.bak', 'utf8')), v1);
  const stored = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(stored.version, 3); assert.deepEqual(stored.machines.map((m) => m.name), ['Orion', 'Other']);
  assert.equal(stored.machines[0].description, undefined); assert.equal(stored.machines[1].description, undefined); assert.equal(stored.machines[0].dashboardPass, 'pw');
  const agents = (await (await request('/api/agents')).json()).agents; assert.equal(agents[0].description, ''); assert.equal(agents[0].kind, 'hermes');
  // Owner edits after migration are never overwritten by a restart.
  assert.equal((await request('/api/connections/Orion', { description: 'Mine now' }, 'PUT')).status, 200);
  const again = await createHub({ configPath, singleUser: true }); again.close();
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).machines[0].description, 'Mine now');
});

test('draft test probes without saving and reuses saved secrets when editing', async (t) => {
  const mock = await mockHermes(t);
  const { request, configPath } = await setup(t, { version: 2, machines: [mock.connection] });
  const ok = await (await request('/api/connections/test', { name: 'fixture', profile: 'default' }, 'POST')).json();
  assert.equal(ok.ok, true); assert.equal(ok.checks.api.ok, true);
  const draft = await (await request('/api/connections/test', { ...mock.connection, name: 'fresh', apiServerKey: 'wrong' }, 'POST')).json();
  assert.equal(draft.checks.api.ok, false);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).machines.map((m) => m.name), ['fixture']);
  assert.equal((await request('/api/connections/test', { name: 'bad', host: 'not a host' }, 'POST')).status, 400);
});
