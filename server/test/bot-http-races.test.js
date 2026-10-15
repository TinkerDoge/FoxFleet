// Hold a real atomic store rename to exercise authorization after async queueing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import http from 'node:http';
import { bootHub, member, addBot } from './bot-helpers.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = (text, session_id) => ({ messages: [{ role: 'user', content: text }], ...(session_id ? { session_id } : {}) });
function holdRename(t, file) {
  const real = fsp.rename; let release, entered, armed = true;
  const gate = new Promise((r) => { release = r; }), held = new Promise((r) => { entered = r; });
  fsp.rename = async (...args) => { if (armed && String(args[1]) === file) { armed = false; entered(); await gate; } return real(...args); };
  syncBuiltinESMExports();
  t.after(() => { release(); fsp.rename = real; syncBuiltinESMExports(); });
  return { release, held: Promise.race([held, sleep(4000).then(() => { throw new Error('rename hold never engaged'); })]) };
}

test('HTTP queued request stays fenced after account disable followed by re-enable', async (t) => {
  const h = await bootHub(t), alice = await member(h), b = await addBot(t, h, 'memberbot', { token: alice.token });
  const route = '/api/agents/memberbot/messages';
  const id = (await (await h.call(route, { token: alice.token, data: user('first') })).json()).session_id;
  const file = path.join(h.dir, 'users', alice.id, 'bot', `${b.botId}.json`), hold = holdRename(t, file);
  const blocker = h.call(route, { token: alice.token, data: user('blocker', id) }); await hold.held;
  const late = h.call('/api/bot/rpc', { data: { t: 'message.send', id: 'late', chat_id: id, text: 'must-not-write' }, headers: { Authorization: `Bot ${b.token}` } });
  await sleep(100);
  const disable = h.call(`/api/admin/users/${alice.id}`, { method: 'PATCH', data: { disabled: true } });
  // Wait for the disabled bit to be persisted, while its API response waits on the held bot store.
  let observedDisabled = false;
  for (let i = 0; i < 100; i++) { const users = await (await h.call('/api/admin/users')).json(); if (users.users.find((u) => u.id === alice.id)?.disabled) { observedDisabled = true; break; } await sleep(10); }
  assert.equal(observedDisabled, true, 'disable actually reached the account store');
  assert.equal((await h.call(`/api/admin/users/${alice.id}`, { method: 'PATCH', data: { disabled: false } })).status, 200);
  hold.release(); assert.equal((await blocker).status, 202); assert.equal((await disable).status, 200);
  assert.equal((await late).status, 401);
  const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.ok(!saved.messages[id].some((m) => m.text === 'must-not-write'));
});

test('HTTP rechecks credentials after the body arrives, including refused protocol operations', async (t) => {
  const h = await bootHub(t), b = await addBot(t, h, 'slow');
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port: h.port, path: '/api/bot/rpc', method: 'POST', headers: { Authorization: `Bot ${b.token}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.write('{"t":"ping",');
  });
  t.after(() => req.destroy()); await sleep(100);
  assert.equal((await h.call('/api/agents/slow/bot-token', { method: 'DELETE' })).status, 200);
  req.end('"id":"late"}');
  assert.equal(await response, 401);
});

for (const kind of ['revoke', 'rotate', 'disable', 'agent-delete', 'account-delete']) test(`HTTP ${kind} refuses queued writes and old token admission`, async (t) => {
  const h = await bootHub(t), alice = await member(h), b = await addBot(t, h, 'mbot', { token: alice.token });
  const c = await b.connect(); await c.next((x) => x.t === 'hello');
  const route = '/api/agents/mbot/messages';
  const id = (await (await h.call(route, { token: alice.token, data: user('first') })).json()).session_id;
  const file = path.join(h.dir, 'users', alice.id, 'bot', `${b.botId}.json`), hold = holdRename(t, file);
  const blocker = h.call(route, { token: alice.token, data: user('blocker', id) }); await hold.held;
  const frame = { t: 'message.send', id: 'late', chat_id: id, text: 'must-not-write' };
  const call = () => h.call('/api/bot/rpc', { data: frame, headers: { Authorization: `Bot ${b.token}` } });
  const late = call(); await sleep(100);
  const change = kind === 'revoke' ? h.call('/api/agents/mbot/bot-token', { token: alice.token, method: 'DELETE' })
    : kind === 'rotate' ? h.call('/api/agents/mbot/bot-token', { token: alice.token, data: {} })
    : kind === 'agent-delete' ? h.call('/api/connections/mbot', { token: alice.token, method: 'DELETE' })
    : h.call(`/api/admin/users/${alice.id}`, { method: kind === 'disable' ? 'PATCH' : 'DELETE', ...(kind === 'disable' ? { data: { disabled: true } } : {}) });
  let answered = false; change.then(() => { answered = true; });
  // The close is an observable barrier after the management change has actually invalidated authority.
  // A fixed sleep alone can release the write before token-index fsync under a busy full-suite run.
  assert.equal((await c.waitClose()).code, ['revoke', 'rotate'].includes(kind) ? 4001 : 4003);
  assert.equal(answered, false, 'management must wait for an already committing write');
  hold.release(); assert.equal((await blocker).status, 202); assert.equal((await change).status, kind === 'rotate' ? 201 : 200);
  assert.equal((await late).status, 401); assert.equal((await call()).status, 401);
  if (kind === 'agent-delete') assert.equal(await fsp.stat(file).then(() => true, () => false), false);
  else { const saved = JSON.parse(await fsp.readFile(file, 'utf8')); assert.ok(!saved.messages[id].some((m) => m.text === 'must-not-write')); }
});

test('HTTP committing write completes before token revocation answers', async (t) => {
  const h = await bootHub(t), b = await addBot(t, h, 'commit');
  const id = (await (await h.call('/api/agents/commit/messages', { data: user('first') })).json()).session_id;
  const file = path.join(h.dir, 'bot', `${b.botId}.json`), hold = holdRename(t, file);
  const write = h.call('/api/bot/rpc', { data: { t: 'message.send', id: 'commit', chat_id: id, text: 'committing' }, headers: { Authorization: `Bot ${b.token}` } }); await hold.held;
  const revoke = h.call('/api/agents/commit/bot-token', { method: 'DELETE' });
  let answered = false; revoke.then(() => { answered = true; }); await sleep(100); assert.equal(answered, false);
  hold.release(); assert.equal((await write).status, 200); assert.equal((await revoke).status, 200);
  const saved = await fsp.readFile(file, 'utf8'); assert.ok(JSON.parse(saved).messages[id].some((m) => m.text === 'committing'));
  await sleep(50); assert.equal(await fsp.readFile(file, 'utf8'), saved);
});
