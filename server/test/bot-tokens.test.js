// Bot registration and token lifecycle (flag on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bootHub, member } from './bot-helpers.js';

const register = async (h, data = {}, token) => { const r = await h.call('/api/connections', { token, data: { kind: 'hermes', connection: 'bot', name: 'helper', ...data } }); return r; };

test('register: hub generates the botId, no host fields, hasBotToken false; edit keeps botId and mode', async (t) => {
  const h = await bootHub(t);
  const r = await register(h, { botId: 'ffffffffffffffffffffffff', host: 'evil.example', label: 'Helper', apiServerKey: 'x' });
  assert.equal(r.status, 201); const { connection: c } = await r.json();
  assert.match(c.botId, /^[0-9a-f]{24}$/); assert.notEqual(c.botId, 'ffffffffffffffffffffffff');
  assert.equal(c.connection, 'bot'); assert.equal(c.kind, 'hermes'); assert.equal(c.profile, 'default'); assert.equal(c.hasBotToken, false); assert.equal(c.label, 'Helper');
  assert.ok(!Object.keys(c).some((k) => /host|port|url|key|pass|machine|upload/i.test(k)), 'no host or credential fields: ' + Object.keys(c));
  const put = await h.call('/api/connections/helper', { method: 'PUT', data: { label: 'Renamed', botId: '000000000000000000000000' } });
  assert.equal(put.status, 200); const edited = (await put.json()).connection; assert.equal(edited.label, 'Renamed'); assert.equal(edited.botId, c.botId); assert.equal(edited.hasBotToken, false);
  assert.equal((await h.call('/api/connections/helper', { method: 'PUT', data: { connection: 'direct', host: '127.0.0.1' } })).status, 400);
  const list = await (await h.call('/api/connections')).json(); assert.equal(list.connections.find((x) => x.name === 'helper').hasBotToken, false);
  const info = await (await h.call('/api/auth')).json(); assert.ok(info.hub.features.includes('botApi'));
});

test('mint: shape, auth, ownership (another account sees 404), direct agents refuse (409)', async (t) => {
  const h = await bootHub(t);
  await register(h);
  assert.equal((await h.call('/api/agents/helper/bot-token', { token: '', data: {} })).status, 401);
  const r = await h.call('/api/agents/helper/bot-token', { data: {} });
  assert.equal(r.status, 201); const body = await r.json();
  assert.match(body.token, /^ffb_[A-Za-z0-9_-]{43}$/); assert.match(body.bot_id, /^[0-9a-f]{24}$/); assert.ok(Number.isInteger(body.created));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const alice = await member(h);
  assert.equal((await h.call('/api/agents/helper/bot-token', { token: alice.token, data: {} })).status, 404, "another account's registry does not hold it");
  assert.equal((await register(h, { name: 'mine' }, alice.token)).status, 201, 'a member registers bots in its own registry');
  const own = await h.call('/api/agents/mine/bot-token', { token: alice.token, data: {} }); assert.equal(own.status, 201);
  assert.notEqual((await own.json()).bot_id, body.bot_id);
  await h.call('/api/connections', { data: { name: 'desk', host: '127.0.0.1', dashboardPort: 9, apiServerPort: 9 } });
  assert.equal((await h.call('/api/agents/desk/bot-token', { data: {} })).status, 409);
  assert.equal((await h.call('/api/agents/desk/bot-token', { method: 'DELETE' })).status, 409);
});

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath ?? e.path, e.name));
  return out;
}
const sha = (v) => createHash('sha256').update(v).digest('hex');

test('tokens are stored only as sha256 (0600), never returned again or logged; rotate and revoke replace the hash', async (t) => {
  const logged = []; const orig = console.log; console.log = (...a) => { logged.push(a.join(' ')); };
  process.env.FOXFLEET_DEBUG = '1'; t.after(() => { console.log = orig; delete process.env.FOXFLEET_DEBUG; });
  const h = await bootHub(t);
  await register(h);
  const { token, bot_id } = await (await h.call('/api/agents/helper/bot-token', { data: {} })).json();
  const file = path.join(h.dir, 'bot', 'tokens.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const index = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(index.tokens.map((x) => [x.hash, x.bot_id]), [[sha(token), bot_id]]);
  assert.match(index.tokens[0].hash, /^[0-9a-f]{64}$/);
  for (const f of await filesUnder(h.dir)) assert.ok(!(await readFile(f, 'utf8')).includes(token), `token must not appear in ${f}`);
  const views = [await (await h.call('/api/connections')).text(), await (await h.call('/api/agents')).text(), await (await h.call('/api/agents/helper')).text()];
  for (const v of views) { assert.ok(!v.includes(token) && !v.includes(sha(token))); assert.match(v, /"hasBotToken":true/); }
  const second = await (await h.call('/api/agents/helper/bot-token', { data: {} })).json();
  assert.notEqual(second.token, token); assert.equal(second.bot_id, bot_id);
  const rotated = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(rotated.tokens.map((x) => x.hash), [sha(second.token)], 'old hash is gone before the response');
  assert.equal((await h.call('/api/agents/helper/bot-token', { method: 'DELETE' })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).tokens, []);
  assert.match(await (await h.call('/api/connections')).text(), /"hasBotToken":false/);
  assert.equal((await h.call('/api/agents/nope/bot-token', { method: 'DELETE' })).status, 404);
  assert.ok(logged.length > 0, 'debug logging was on');
  for (const line of logged) assert.ok(!line.includes(token) && !line.includes(second.token) && !line.includes(sha(token)) && !line.includes(sha(second.token)));
});
