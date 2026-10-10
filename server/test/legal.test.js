// Terms acceptance is recorded (version + time) on setup and register, optional for older clients, validated when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../index.js';
import { TERMS_VERSION, acceptedTerms } from '../legal.js';

async function hub(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-legal-'));
  const server = await createHub({ configPath: path.join(dir, 'config.json') }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const call = (route, { token, data, method = data === undefined ? 'GET' : 'POST' } = {}) => fetch(base + route, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { dir, call };
}
const PW = 'correct horse battery';

test('acceptedTerms: optional, short label only', () => {
  assert.equal(acceptedTerms(undefined), null); assert.equal(acceptedTerms(''), null); assert.equal(acceptedTerms('1.0'), '1.0');
  for (const bad of [1, {}, 'a b', 'x'.repeat(33), '<script>']) assert.throws(() => acceptedTerms(bad), /Invalid terms version/);
});

test('GET /api/auth reports the current terms version', async (t) => {
  const h = await hub(t); const info = await (await h.call('/api/auth')).json();
  assert.equal(info.termsVersion, TERMS_VERSION);
});

test('setup and register record the accepted version and time; older clients may omit it', async (t) => {
  const h = await hub(t);
  assert.equal((await h.call('/api/auth/setup', { data: { username: 'owner1', password: PW, client: 'app', acceptedTerms: '<x>' } })).status, 400);
  const r = await h.call('/api/auth/setup', { data: { username: 'owner1', password: PW, client: 'app', acceptedTerms: TERMS_VERSION } });
  assert.equal(r.status, 200); const { token, user } = await r.json(); assert.equal(user.acceptedTerms, TERMS_VERSION);
  assert.equal((await h.call('/api/admin/settings', { token, method: 'PUT', data: { registration: 'open' } })).status, 200);
  const legacy = await (await h.call('/api/auth/register', { data: { username: 'olduser', password: PW, client: 'app' } })).json();
  assert.equal(legacy.user.acceptedTerms, null);
  const fresh = await (await h.call('/api/auth/register', { data: { username: 'newuser', password: PW, client: 'app', acceptedTerms: TERMS_VERSION } })).json();
  assert.equal(fresh.user.acceptedTerms, TERMS_VERSION);
  const users = JSON.parse(await readFile(path.join(h.dir, 'accounts', 'users.json'), 'utf8')).users;
  const rec = users.find((u) => u.username === 'newuser'); assert.equal(rec.terms.version, TERMS_VERSION); assert.ok(Math.abs(rec.terms.at - Date.now()) < 60_000);
  assert.equal(users.find((u) => u.username === 'olduser').terms, undefined);
});
