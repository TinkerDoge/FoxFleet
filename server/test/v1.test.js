// v1.0: provider plugins + config v3, multi-user accounts/login gate, reverse connector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
import { accountStore, hashPassword, verifyPassword } from '../accounts.js';

async function hub(t, { raw, ...options } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-v1-')), configPath = path.join(dir, 'config.json');
  if (raw) await writeFile(configPath, JSON.stringify(raw));
  const server = await createHub({ configPath, ...options }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 20)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const call = (route, { token, data, method = data === undefined ? 'GET' : 'POST', headers = {} } = {}) => fetch(base + route, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { server, base, dir, configPath, call };
}
const PW = 'correct horse battery';
async function owner(h, username = 'owner1') { const r = await h.call('/api/auth/setup', { data: { username, password: PW, client: 'app' } }); assert.equal(r.status, 200); return (await r.json()).token; }

test('passwords: scrypt hash verifies and never stores plaintext', async () => {
  const h = await hashPassword('s3cret-pass-word'); assert.match(h, /^scrypt\$/); assert.ok(!h.includes('s3cret'));
  assert.equal(await verifyPassword('s3cret-pass-word', h), true); assert.equal(await verifyPassword('nope', h), false);
});

test('gate: nothing works before setup; setup creates the owner once; then login', async (t) => {
  const h = await hub(t);
  const a = await (await h.call('/api/auth')).json(); assert.equal(a.setupRequired, true); assert.equal(a.authenticated, false);
  assert.equal((await h.call('/api/connections')).status, 401);
  assert.equal((await h.call('/api/auth/setup', { data: { username: 'owner1', password: 'short' } })).status, 400);
  const token = await owner(h); assert.ok(token.includes('.'));
  assert.equal((await h.call('/api/auth/setup', { data: { username: 'x1y', password: PW } })).status, 409);
  assert.equal((await h.call('/api/connections', { token })).status, 200);
  const info = await (await h.call('/api/auth', { token })).json(); assert.equal(info.user.role, 'owner'); assert.equal(info.setupRequired, false);
  const raw = await readFile(path.join(h.dir, 'accounts', 'users.json'), 'utf8'); assert.ok(!raw.includes(PW)); assert.match(raw, /scrypt\$/);
  const dev = await readFile(path.join(h.dir, 'accounts', 'devices.json'), 'utf8'); assert.ok(!dev.includes(token.split('.')[1]), 'tokens are stored hashed');
  assert.equal((await h.call('/api/auth/login', { data: { username: 'owner1', password: 'wrong-password-1' } })).status, 401);
  const web = await h.call('/api/auth/login', { data: { username: 'OWNER1', password: PW } }); assert.equal(web.status, 200);
  const cookie = web.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.equal((await web.json()).token, undefined);
  assert.equal((await h.call('/api/connections', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
});

test('lockout: five wrong passwords lock the account even for the right one', async (t) => {
  const h = await hub(t); await owner(h);
  for (let i = 0; i < 5; i++) assert.equal((await h.call('/api/auth/login', { data: { username: 'owner1', password: 'bad-password-' + i } })).status, 401);
  const locked = await h.call('/api/auth/login', { data: { username: 'owner1', password: PW } }); assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) > 0);
});

test('devices: list, revoke one, sign out everywhere, password change signs out others', async (t) => {
  const h = await hub(t); const t1 = await owner(h);
  const login = async (name) => (await (await h.call('/api/auth/login', { data: { username: 'owner1', password: PW, client: 'app', deviceName: name } })).json());
  const d2 = await login('Pixel'), d3 = await login('Tablet');
  const list = (await (await h.call('/api/auth/devices', { token: t1 })).json()).devices; assert.equal(list.length, 3); assert.equal(list.filter((d) => d.current).length, 1);
  assert.equal((await h.call(`/api/auth/devices/${d2.deviceId}`, { token: t1, method: 'DELETE' })).status, 200);
  assert.equal((await h.call('/api/connections', { token: d2.token })).status, 401);
  assert.equal((await h.call('/api/auth/password', { token: t1, data: { current: 'wrong-wrong-1', next: 'another long password' } })).status, 403);
  assert.equal((await h.call('/api/auth/password', { token: t1, data: { current: PW, next: 'another long password' } })).status, 200);
  assert.equal((await h.call('/api/connections', { token: d3.token })).status, 401, 'other devices signed out');
  assert.equal((await h.call('/api/connections', { token: t1 })).status, 200, 'this device stays');
  assert.equal((await h.call('/api/auth/login', { data: { username: 'owner1', password: PW } })).status, 401);
  assert.equal((await h.call('/api/auth/logout-all', { token: t1, data: {} })).status, 200);
  assert.equal((await h.call('/api/connections', { token: t1 })).status, 401);
});

test('tokens rotate: refresh issues a new token, the old one dies after the grace window', async (t) => {
  let clock = Date.now();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-acc-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const acc = await accountStore(dir, { now: () => clock }), u = await acc.createUser('rotator', PW);
  const { token, deviceId } = await acc.createSession(u.id);
  const fresh = await acc.rotate(deviceId); assert.notEqual(fresh, token);
  assert.ok(await acc.authenticate(token), 'old token still valid inside the grace window');
  clock += 61_000; assert.equal(await acc.authenticate(token), null); assert.ok(await acc.authenticate(fresh));
  clock += 25 * 3600_000; const auto = await acc.authenticate(fresh); assert.ok(auto.rotated, 'older than a day rotates on use');
  clock += 31 * 86400_000; assert.equal(await acc.authenticate(auto.rotated), null, 'sessions expire');
});

test('registration: closed by default; invite mode needs a valid single-use invite; owner-only admin', async (t) => {
  const h = await hub(t); const o = await owner(h);
  assert.equal((await h.call('/api/auth/register', { data: { username: 'alice', password: PW } })).status, 403);
  assert.equal((await h.call('/api/admin/settings', { token: o, method: 'PUT', data: { registration: 'invite' } })).status, 200);
  assert.equal((await h.call('/api/auth/register', { data: { username: 'alice', password: PW, invite: 'nope' } })).status, 403);
  const inv = await (await h.call('/api/admin/invites', { token: o, data: {} })).json();
  const reg = await h.call('/api/auth/register', { data: { username: 'alice', password: PW, invite: inv.code, client: 'app' } }); assert.equal(reg.status, 200); const alice = (await reg.json()).token;
  assert.equal((await h.call('/api/auth/register', { data: { username: 'bob', password: PW, invite: inv.code } })).status, 403, 'single use');
  assert.equal((await h.call('/api/admin/settings', { token: alice, method: 'PUT', data: { registration: 'open' } })).status, 403);
  assert.equal((await h.call('/api/admin/invites', { token: alice, data: {} })).status, 403);
  await h.call('/api/admin/settings', { token: o, method: 'PUT', data: { registration: 'open' } });
  assert.equal((await h.call('/api/auth/register', { data: { username: 'carol', password: PW } })).status, 200);
  assert.equal((await h.call('/api/auth/register', { data: { username: 'alice', password: PW } })).status, 409);
});

test('per-user registries: agents and secrets are isolated between users', async (t) => {
  const h = await hub(t); const o = await owner(h);
  await h.call('/api/admin/settings', { token: o, method: 'PUT', data: { registration: 'open' } });
  const alice = (await (await h.call('/api/auth/register', { data: { username: 'alice', password: PW, client: 'app' } })).json()).token;
  const desk = { name: 'Chat', host: '127.0.0.1', dashboardPort: 9, apiServerPort: 9 };
  const add = await h.call('/api/connections', { token: o, data: { ...desk, apiServerKey: 'sk-owner-secret', label: 'Owner desk' } }); assert.equal(add.status, 201);
  assert.deepEqual((await (await h.call('/api/connections', { token: alice })).json()).connections, []);
  assert.deepEqual((await (await h.call('/api/agents', { token: alice })).json()).agents, []);
  assert.equal((await h.call('/api/connections/Chat', { token: alice, method: 'DELETE' })).status, 404);
  assert.equal((await h.call('/api/connections', { token: alice, data: { ...desk, apiServerKey: 'sk-alice-secret', label: 'Alice desk' } })).status, 201);
  const mine = (await (await h.call('/api/connections', { token: o })).json()).connections; assert.equal(mine.length, 1); assert.equal(mine[0].label, 'Owner desk');
  const text = await (await h.call('/api/connections', { token: alice })).text(); assert.ok(text.includes('Alice desk') && !text.includes('sk-alice-secret') && !text.includes('sk-owner-secret'));
});

test('setup code: a hub bound beyond loopback demands the printed setup code', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-lan-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const server = await createHub({ configPath: path.join(dir, 'config.json'), host: '0.0.0.0', trustedOrigins: 'http://127.0.0.1:1' });
  t.after(() => new Promise((r) => server.close(r))); assert.ok(server.setupCode.length >= 8);
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  const post = (code) => fetch(`http://127.0.0.1:${port}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: '127.0.0.1:1' }, body: JSON.stringify({ username: 'owner1', password: PW, setupCode: code }) });
  assert.equal((await post('guess')).status, 403);
});

test('legacy FOXFLEET_PASSWORD bootstraps owner "owner" and adopts the existing registry', async (t) => {
  const mock = await mockHermes(t);
  const h = await hub(t, { raw: { version: 3, machines: [{ ...mock.connection, connection: 'direct' }] }, ownerPassword: 'legacy-password' });
  const r = await h.call('/api/auth/login', { data: { username: 'owner', password: 'legacy-password', client: 'app' } }); assert.equal(r.status, 200);
  const agents = (await (await h.call('/api/agents', { token: (await r.json()).token })).json()).agents; assert.equal(agents.length, 1);
});

test('kinds: the Hermes schema offers direct connection as an advanced option; no URLs leak', async (t) => {
  const h = await hub(t, { singleUser: true });
  const kinds = (await (await h.call('/api/agent-kinds')).json()).kinds, by = Object.fromEntries(kinds.map((k) => [k.kind, k]));
  assert.deepEqual(Object.keys(by), ['hermes']);
  assert.equal(by.hermes.fields.find((f) => f.key === 'connection').default, 'direct');
  assert.ok(by.hermes.fields.find((f) => f.key === 'host').advanced);
  assert.doesNotMatch(JSON.stringify(kinds), /https?:\/\//);
});

test('migration v2 -> v3: hermes becomes direct; agents of removed kinds stay in the file untouched; backup kept', async (t) => {
  t.mock.method(console, 'warn', () => {}); // "ignoring 2 saved agent(s)" (see v05.test.js)
  const legacy = [{ name: 'A', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'm', apiKey: 'k' }, { name: 'B', kind: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm', apiKey: 'k' }];
  const h = await hub(t, { singleUser: true, raw: { version: 2, machines: [...legacy, { name: 'D', host: '10.0.0.5', profile: 'default', dashboardPort: 9119, apiServerPort: 8642 }] } });
  const stored = JSON.parse(await readFile(h.configPath, 'utf8')); assert.equal(stored.version, 3);
  assert.deepEqual(stored.machines.map((m) => m.name), ['D', 'A', 'B']); assert.deepEqual(stored.machines.slice(1), legacy);
  assert.equal(stored.machines[0].connection, 'direct');
  assert.match(await readFile(h.configPath + '.v2.bak', 'utf8'), /"version":\s*2/);
});

test('connector files are served without auth and carry no secrets', async (t) => {
  const h = await hub(t);
  const js = await h.call('/connector.mjs'); assert.equal(js.status, 200); assert.match(await js.text(), /foxfleet\.v1/);
  assert.equal((await h.call('/connect-agent.md')).status, 200);
});
