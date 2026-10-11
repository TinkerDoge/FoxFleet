import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reactionStore, validEmoji } from '../reactions.js';
import { historyStore } from '../history.js';
import { createHub } from '../index.js';

test('reactions persist, retry idempotently, and isolate conversations and actors', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-reactions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reactions.json'); const s = await reactionStore(file);
  const human = { id: 'user:u', name: 'Owner', kind: 'human' }, bot = { id: 'agent:a', name: 'Atlas', kind: 'agent' };
  await s.set('a', 's', 'm', '❤️', human, true);
  await s.set('a', 's', 'm', '❤️', human, true);
  await s.set('a', 's', 'm', '❤️', bot, true);
  assert.equal(s.list('a', 's').m[0].actors.length, 2);
  assert.deepEqual(s.list('b', 's'), {});
  assert.deepEqual(s.list('a', 'other'), {});
  const again = await reactionStore(file);
  assert.equal(again.list('a', 's').m[0].actors.length, 2);
  await again.set('a', 's', 'm', '❤️', human, false);
  await again.set('a', 's', 'm', '❤️', human, false);
  assert.deepEqual(again.list('a', 's').m[0].actors, [bot]);
  await again.remove('a', 's'); assert.deepEqual(again.list('a', 's'), {});
});

test('emoji validation accepts one complete emoji and rejects text, multiple emoji and invisible abuse', () => {
  for (const e of ['❤️', '👍🏽', '👩‍💻', '🇹🇭', '1️⃣', '🦊']) assert.equal(validEmoji(e), true, e);
  for (const e of ['', 'hello', 'a🦊', '🦊🦊', ' ', '1', '<script>', '🦊\n', '🦊\u200b']) assert.equal(validEmoji(e), false, e);
});

test('legacy and new history messages get distinct persisted IDs, including identical messages', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-ids-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json'), now = Date.now();
  await writeFile(file, JSON.stringify({ version: 1, retentionDays: 90, agents: { a: { sessions: [{ id: 's', title: 't', updated: now, messages: [{ role: 'user', content: 'same', ts: now }, { role: 'user', content: 'same', ts: now }] }] } } }));
  const h = await historyStore(file); const ids = h.messages('a', 's').messages.map(m => m.id);
  assert.ok(ids.every(id => typeof id === 'string' && id.length > 0)); assert.equal(new Set(ids).size, 2);
  await h.flush(); assert.deepEqual((await historyStore(file)).messages('a', 's').messages.map(m => m.id), ids);
  await h.append('a', 's', 'same', 'answer'); const all = h.messages('a', 's').messages;
  assert.equal(new Set(all.map(m => m.id)).size, 4);
  assert.equal(h.messages('a', 's', { limit: 1, offset: 2 }).messages[0].id, ids[1]);
});

test('HTTP and agent MCP reactions share state, bind actors, and reject other messages', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-reaction-http-'));
  const hub = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true });
  await new Promise(r => hub.listen(0, '127.0.0.1', r));
  t.after(async () => { hub.closeAllConnections(); await new Promise(r => hub.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const call = (p, method = 'GET', body, token) => fetch(`http://127.0.0.1:${hub.address().port}${p}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const added = await (await call('/api/connections', 'POST', { name: 'scribe', kind: 'mcp-inbox' })).json();
  assert.ok(added.inboxToken);
  const sent = await call('/api/agents/scribe/chat', 'POST', { messages: [{ role: 'user', content: 'Please check this' }] });
  const sid = sent.headers.get('x-hermes-session-id'); await sent.text();
  const message = (await (await call(`/api/agents/scribe/sessions/${sid}/messages`)).json()).messages[0];
  const endpoint = `/api/agents/scribe/sessions/${sid}/reactions`;
  const r = await call(endpoint, 'PUT', { message_id: message.id, emoji: '🦊', actor: { id: 'agent:fake' } }); assert.equal(r.status, 200);
  const human = await r.json(); assert.equal(human.messages[message.id][0].actors[0].kind, 'human');
  const rpc = await (await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hub_react', arguments: { thread_id: sid, message_id: message.id, emoji: '🦊' } } }, added.inboxToken)).json();
  assert.equal(rpc.result.isError, false);
  const shared = await (await call(endpoint)).json(); assert.equal(shared.messages[message.id][0].actors.length, 2);
  assert.equal((await call(endpoint, 'PUT', { message_id: 'fake', emoji: '🦊' })).status, 404);
  assert.equal((await call(endpoint, 'PUT', { message_id: message.id, emoji: 'not emoji' })).status, 400);
  await call(endpoint, 'DELETE', { message_id: message.id, emoji: '🦊' });
  const remaining = await (await call(endpoint)).json(); assert.equal(remaining.messages[message.id][0].actors[0].id, 'agent:scribe');
});

test('hidden messages: idempotent, per conversation, survive reload, cleaned with sessions, agents and accounts', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-hidden-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reactions.json');
  await writeFile(file, JSON.stringify({ version: 1, rows: [] })); // a 0.3.8 store loads with nothing hidden
  const s = await reactionStore(file);
  assert.deepEqual(s.hidden('a', 's'), []);
  await s.hide('a', 's', 'm1', true); await s.hide('a', 's', 'm1', true); await s.hide('a', 's', 'm2', true);
  await s.hide('a', 'other', 'm9', true); await s.hide('b', 's', 'm1', true);
  assert.deepEqual(s.hidden('a', 's'), ['m1', 'm2']);
  const again = await reactionStore(file);
  assert.deepEqual(again.hidden('a', 's'), ['m1', 'm2']);
  await again.hide('a', 's', 'm2', false); await again.hide('a', 's', 'm2', false);
  assert.deepEqual(again.hidden('a', 's'), ['m1']);
  await again.retain('a', ['s']); assert.deepEqual(again.hidden('a', 'other'), []); assert.deepEqual(again.hidden('a', 's'), ['m1']);
  await again.remove('a', 's'); assert.deepEqual(again.hidden('a', 's'), []);
  assert.deepEqual(again.hidden('b', 's'), ['m1']); await again.remove('b'); assert.deepEqual(again.hidden('b', 's'), []);
  await again.hide('c', 's', 'x', true); await again.clear(); assert.deepEqual(again.hidden('c', 's'), []);
  await assert.rejects(async () => again.hide('a', 's', '', true), /Invalid message ID/);
});

test('hidden messages never expire on their own (reactions do)', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-hidden-age-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 1_000_000; const s = await reactionStore(path.join(dir, 'reactions.json'), { now: () => clock, retentionMs: 1000 });
  await s.hide('a', 's', 'm', true); clock += 5000; await s.hide('a', 's', 'n', true);
  assert.deepEqual(s.hidden('a', 's'), ['m', 'n']);
});
