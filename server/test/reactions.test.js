import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reactionStore, validEmoji, agentReactions, mergeReactions } from '../reactions.js';
import { createHub } from '../index.js';
import { mockHermes } from './fixtures.js';

// A hub with one Hermes agent ("fixture") whose dashboard serves `messages(sessionPath)` for every session transcript.
async function hermesHub(t, messages) {
  let route = '';
  const up = await mockHermes(t, { beforeDashboardResponse: (req, u) => { route = u.pathname; }, get messages() { return messages(route); } });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-reaction-http-'));
  const hub = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true });
  await new Promise(r => hub.listen(0, '127.0.0.1', r));
  t.after(async () => { hub.closeAllConnections(); await new Promise(r => hub.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const call = (p, method = 'GET', body) => fetch(`http://127.0.0.1:${hub.address().port}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('/api/connections', 'POST', up.connection)).status, 201);
  return call;
}

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


test('HTTP reactions bind the signed-in actor, merge with the agent\'s REACT: lines, and reject other messages', async t => {
  const call = await hermesHub(t, () => [{ id: 'u1', role: 'user', content: 'Please check this' }, { id: 'a1', role: 'assistant', content: 'Looks fine\nREACT: 🦊' }]);
  const endpoint = '/api/agents/fixture/sessions/sess-1/reactions';
  const r = await call(endpoint, 'PUT', { message_id: 'u1', emoji: '🦊', actor: { id: 'agent:fake' } }); assert.equal(r.status, 200);
  const human = await r.json(); assert.equal(human.messages.u1[0].actors[0].kind, 'human');
  const shared = await (await call(endpoint)).json(); assert.equal(shared.messages.u1[0].actors.length, 2);
  assert.equal((await call(endpoint, 'PUT', { message_id: 'fake', emoji: '🦊' })).status, 404);
  assert.equal((await call(endpoint, 'PUT', { message_id: 'u1', emoji: 'not emoji' })).status, 400);
  await call(endpoint, 'DELETE', { message_id: 'u1', emoji: '🦊' });
  const remaining = await (await call(endpoint)).json(); assert.equal(remaining.messages.u1[0].actors[0].id, 'agent:fixture');
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

test('agent reactions come from REACT: lines and land on the nearest earlier user message', () => {
  const bot = { id: 'agent:atlas', name: 'Atlas', kind: 'agent' };
  const msgs = [
    { id: 'u1', role: 'user', content: 'hello' }, { id: 'a1', role: 'assistant', content: 'Hi!\nREACT: 👋' },
    { id: 'u2', role: 'user', content: 'thanks' }, { id: 'a2', role: 'assistant', content: 'REACT: ❤️\nREACT: 🎉' },
    { role: 'user', content: 'no id yet' }, { id: 'a3', role: 'assistant', content: 'REACT: 👍👍' }, // two emoji: shaped, but not one RGI emoji
    { id: 'a4', role: 'assistant', content: '```\nREACT: 🦊\n```' },
  ];
  assert.deepEqual(agentReactions(msgs, bot), [{ message: 'u1', emoji: '👋', actor: bot }, { message: 'u2', emoji: '❤️', actor: bot }]);
  const human = { id: 'user:u', name: 'Owner', kind: 'human' };
  const merged = mergeReactions({ u2: [{ emoji: '❤️', actors: [human, bot] }] }, agentReactions(msgs, bot));
  assert.deepEqual(merged.u2, [{ emoji: '❤️', actors: [human, bot] }]); // an actor counts once
  assert.deepEqual(merged.u1, [{ emoji: '👋', actors: [bot] }]);
});

test('a REACT: symbol without the emoji variation selector gets one', () => {
  const bot = { id: 'agent:atlas', name: 'Atlas', kind: 'agent' };
  const msgs = [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'REACT: \u2764' }, { id: 'u2', role: 'user', content: 'ok' }, { id: 'a2', role: 'assistant', content: 'REACT: \u263A' }, { id: 'u3', role: 'user', content: 'x' }, { id: 'a3', role: 'assistant', content: 'REACT: A' }];
  assert.deepEqual(agentReactions(msgs, bot), [{ message: 'u1', emoji: '\u2764\uFE0F', actor: bot }, { message: 'u2', emoji: '\u263A\uFE0F', actor: bot }]);
});

test('HTTP: agent REACT: lines show as reactions, and hiding is per account and idempotent', async t => {
  const call = await hermesHub(t, () => [{ id: 'u1', role: 'user', content: 'I fixed the bug' }, { id: 'a1', role: 'assistant', content: 'Nice work!\nREACT: ❤️' }]);
  const snap = await (await call('/api/agents/fixture/sessions/sess-1/reactions')).json();
  assert.deepEqual(snap.messages.u1, [{ emoji: '❤️', actors: [{ id: 'agent:fixture', name: 'fixture', kind: 'agent' }] }]);
  assert.deepEqual(snap.hidden, []);
  const hiddenUrl = '/api/agents/fixture/sessions/sess-1/hidden';
  assert.equal((await call(hiddenUrl, 'PUT', { message_id: 'nope' })).status, 404);
  const h1 = await (await call(hiddenUrl, 'PUT', { message_id: 'a1' })).json();
  const h2 = await (await call(hiddenUrl, 'PUT', { message_id: 'a1' })).json();
  assert.deepEqual(h1.hidden, ['a1']); assert.deepEqual(h2.hidden, ['a1']);
  assert.deepEqual((await (await call('/api/agents/fixture/sessions/sess-1/reactions')).json()).hidden, ['a1']);
  assert.deepEqual((await (await call(hiddenUrl, 'DELETE', { message_id: 'a1' })).json()).hidden, []);
  const agents = (await (await call('/api/agents')).json()).agents;
  assert.equal(agents.find(a => a.name === 'fixture').capabilities.agentReactions, true);
});

test('hidden messages: the global cap evicts the oldest, the per-conversation cap rejects', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-hidden-cap-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 1000; const s = await reactionStore(path.join(dir, 'reactions.json'), { now: () => clock++, hiddenLimit: 3 });
  for (const [session, id] of [['s1', 'a'], ['s2', 'b'], ['s3', 'c'], ['s4', 'd']]) await s.hide('x', session, id, true);
  assert.deepEqual(s.hidden('x', 's1'), []); // 'a' was the oldest
  assert.deepEqual([s.hidden('x', 's2'), s.hidden('x', 's3'), s.hidden('x', 's4')], [['b'], ['c'], ['d']]);
  const per = await reactionStore(path.join(dir, 'per.json'), { hiddenPerSession: 2 });
  await per.hide('x', 's', '1', true); await per.hide('x', 's', '2', true); await per.hide('x', 's', '2', true); // a repeat is not a new entry
  await assert.rejects(per.hide('x', 's', '3', true), e => e.status === 409);
  await per.hide('x', 'other', '3', true); assert.deepEqual(per.hidden('x', 's'), ['1', '2']);
});

test('hidden messages: corrupt entries in the store file are ignored on load', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-hidden-bad-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reactions.json');
  await writeFile(file, JSON.stringify({ version: 2, rows: [], hidden: [null, 7, 'x', { agent: 'a', session: 's' }, { agent: 'a', session: 's', message: 4 }, { agent: 'a', session: 's', message: 'ok', at: 1 }] }));
  const s = await reactionStore(file);
  assert.deepEqual(s.hidden('a', 's'), ['ok']);
  await s.hide('a', 's', 'two', true); assert.deepEqual(s.hidden('a', 's'), ['ok', 'two']);
});

test('mergeReactions copes with a message id of __proto__', () => {
  const bot = { id: 'agent:a', name: 'A', kind: 'agent' };
  const merged = mergeReactions({}, [{ message: '__proto__', emoji: '👍', actor: bot }]);
  assert.deepEqual(merged['__proto__'], [{ emoji: '👍', actors: [bot] }]);
  assert.equal(Object.getPrototypeOf(merged), null);
});

test('HTTP: /hidden refuses ids from another conversation and other methods', async t => {
  const call = await hermesHub(t, (route) => route.includes('/one/') ? [{ id: 'm-one', role: 'user', content: 'first' }] : [{ id: 'm-two', role: 'user', content: 'second' }]);
  assert.equal((await call('/api/agents/fixture/sessions/one/hidden', 'PUT', { message_id: 'm-two' })).status, 404);
  assert.equal((await call('/api/agents/fixture/sessions/two/hidden', 'PUT', { message_id: 'm-two' })).status, 200);
  assert.equal((await call('/api/agents/fixture/sessions/one/hidden', 'POST', { message_id: 'm-one' })).status, 405);
});
