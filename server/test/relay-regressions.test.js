import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../index.js';
import { mockHermes } from './fixtures.js';
import { artifactRegistry } from '../artifacts.js';
import { configStore } from '../config.js';

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
test('the shipped example loads as the documented empty configuration', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-example-')), configPath = path.join(dir, 'config.json');
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  await writeFile(configPath, await readFile(new URL('../config.example.json', import.meta.url)));
  assert.deepEqual((await configStore(configPath)).all(), []);
});
async function setup(t, connections = [], options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-regression-'));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: connections }));
  const server = await createHub({ configPath, singleUser: !options.ownerPassword, ...options });
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  await new Promise((done) => server.listen(0, done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, data, method = 'GET', headers = {}) => fetch(base + route, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { server, base, request };
}

test('artifact registration cannot survive an originating connection edit', async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const original = await mockHermes(t, { beforeDashboardResponse: async (_req, url) => { if (url.pathname.endsWith('/messages')) { entered.resolve(); await release.promise; } } });
  const replacement = await mockHermes(t), { request } = await setup(t, [original.connection]);
  const pending = request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['/outputs/result.png'] }, 'POST');
  await entered.promise;
  assert.equal((await request('/api/connections/fixture', replacement.connection, 'PUT')).status, 200);
  release.resolve();
  const response = await pending, data = await response.json();
  if (response.status === 201) await request(`/api/agents/fixture/artifacts/${data.artifacts[0].id}/content`);
  assert.equal(replacement.requests.some((call) => call.path === '/api/fs/download'), false, 'an old transcript must never authorize files on a replacement connection');
  assert.equal(response.status, 409);
  assert.deepEqual((await (await request('/api/agents/fixture/artifacts')).json()).artifacts, []);
});

test('artifact registry distinguishes connection revisions with the same name and profile', () => {
  const registry = artifactRegistry(), original = { name: 'agent', profile: 'default', host: '127.0.0.1' }, replacement = { ...original, host: '127.0.0.2' };
  const [artifact] = registry.register(original, 'sess-1', ['/outputs/result.png'], { messages: [{ role: 'assistant', content: '/outputs/result.png' }] });
  assert.deepEqual(registry.list(replacement), []);
  assert.throws(() => registry.get(replacement, artifact.id), /Unknown artifact/);
  assert.equal(registry.get(original, artifact.id).id, artifact.id);
});

for (const route of ['logs', 'sessions/sess-1/messages']) for (const mutation of ['edit', 'delete']) test(`${route} drops an upstream result after connection ${mutation}`, async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const mock = await mockHermes(t, { messages: [{ role: 'assistant', content: 'dashboard-secret api-secret' }], beforeDashboardResponse: async (_req, url) => { if (url.pathname === '/api/' + route) { entered.resolve(); await release.promise; } } });
  const { request } = await setup(t, [mock.connection]);
  const pending = request('/api/agents/fixture/' + route); await entered.promise;
  const changed = mutation === 'delete' ? await request('/api/connections/fixture', undefined, 'DELETE') : await request('/api/connections/fixture', { dashboardPass: 'replacement-password', apiServerKey: 'replacement-key' }, 'PUT');
  assert.equal(changed.status, 200); release.resolve();
  const response = await pending, text = await response.text();
  for (const secret of ['dashboard-secret', 'api-secret']) assert.ok(!text.includes(secret), `must not leak retired ${secret}`);
  assert.equal(response.status, 409);
});

test('redaction retains other connections secrets captured before an upstream await', async (t) => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const mock = await mockHermes(t, { logs: [{ msg: 'retired-fleet-password retired-fleet-key current-fleet-password current-fleet-key' }], beforeDashboardResponse: async (_req, url) => { if (url.pathname === '/api/logs') { entered.resolve(); await release.promise; } } });
  const other = { ...mock.connection, name: 'other', dashboardPass: 'retired-fleet-password', apiServerKey: 'retired-fleet-key' };
  const { request } = await setup(t, [mock.connection, other]);
  const pending = request('/api/agents/fixture/logs'); await entered.promise;
  assert.equal((await request('/api/connections/other', { dashboardPass: 'current-fleet-password', apiServerKey: 'current-fleet-key' }, 'PUT')).status, 200); release.resolve();
  const response = await pending, text = await response.text(); assert.equal(response.status, 200);
  for (const secret of ['retired-fleet-password', 'retired-fleet-key', 'current-fleet-password', 'current-fleet-key']) assert.ok(!text.includes(secret), secret);
});

test('supported TCP listen overloads default to loopback and cannot bypass owner authentication', async (t) => {
  const { server } = await setup(t);
  for (const start of [
    (done) => server.listen('0', done),
    (done) => server.listen({ port: '0' }, done),
    (done) => server.listen(0, 16, done),
    (done) => server.listen(0, undefined, done),
    (done) => server.listen(0, '127.0.0.1', 16, done),
  ]) {
    await new Promise((done) => server.close(done)); await new Promise(start);
    assert.equal(server.address().address, '127.0.0.1');
  }
});

test('listen rejects implicit wildcard handles and explicit unauthenticated wildcard hosts', async (t) => {
  const { server } = await setup(t); await new Promise((done) => server.close(done));
  assert.throws(() => server.listen('0', '0.0.0.0'), /single-user/i);
  assert.throws(() => server.listen({ port: 0, host: '::' }), /single-user/i);
  assert.throws(() => server.listen({ fd: 1 }), /Unsupported|port/i);
  assert.throws(() => server.listen({ port: 0, path: 'unsupported.sock' }), /Unsupported|port/i);
  assert.throws(() => server.listen({ port: 0, host: '' }), /host/i);
});

test('mutations reject form-compatible content types without relying on Origin', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]);
  for (const [route, data, method] of [
    ['/api/connections', { name: 'injected', host: 'localhost' }, 'POST'],
    ['/api/connections/fixture', { profile: 'writer' }, 'PUT'],
    ['/api/agents/fixture/cron/daily/pause', {}, 'POST'],
    ['/api/agents/fixture/skills/toggle', { name: 'web-search', enabled: false }, 'POST'],
    ['/api/auth/logout', {}, 'POST'],
  ]) for (const mime of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=fixture']) {
    assert.equal((await request(route, data, method, { 'Content-Type': mime })).status, 415, `${method} ${route} ${mime}`);
  }
  assert.equal((await request('/api/agents/fixture/cron/daily/pause', {}, 'POST')).status, 200);
  assert.equal((await request('/api/connections/fixture', undefined, 'DELETE')).status, 200);
});

test('compressed artifact responses preserve decoded bytes without a compressed length', async (t) => {
  const mock = await mockHermes(t, { gzipFile: true }), { request } = await setup(t, [mock.connection]);
  const artifact = (await (await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['/outputs/result.png'] }, 'POST')).json()).artifacts[0];
  const response = await request(`/api/agents/fixture/artifacts/${artifact.id}/content?download=1`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), null);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mock.bytes);
  assert.equal(mock.requests.find((call) => call.path === '/api/fs/download').acceptEncoding, 'identity');
});

test('a compressed range response is refused rather than misrepresenting byte offsets', async (t) => {
  const mock = await mockHermes(t, { gzipFile: true }), { request } = await setup(t, [mock.connection]);
  const artifact = (await (await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['/outputs/result.png'] }, 'POST')).json()).artifacts[0];
  assert.equal((await request(`/api/agents/fixture/artifacts/${artifact.id}/content`, undefined, 'GET', { Range: 'bytes=0-2' })).status, 502);
});

test('named profile readiness queries presence for the saved profile', async (t) => {
  const mock = await mockHermes(t, { profileSessions: { default: 9, writer: 1 } }), { request } = await setup(t, [{ ...mock.connection, profile: 'writer' }]);
  const agent = (await (await request('/api/agents')).json()).agents[0]; assert.equal(agent.activeSessions, 1);
  assert.ok(mock.requests.filter((call) => call.path === '/api/status').every((call) => call.query.get('profile') === 'writer'));
});

for (const fileStatus of [404, 405]) for (const file of ['/outputs/result.png', '/outputs/notes.txt']) test(`artifact ${fileStatus} for ${file} gives safe actionable guidance`, async (t) => {
  const mock = await mockHermes(t, { fileStatus }), { request } = await setup(t, [mock.connection]);
  const artifact = (await (await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: [file] }, 'POST')).json()).artifacts[0];
  const response = await request(`/api/agents/fixture/artifacts/${artifact.id}/content`), data = await response.json();
  assert.match(data.error, /check Hermes version and session file permissions/i);
  assert.equal(response.status, fileStatus); assert.ok(!data.error.includes('private upstream secret'));
});
