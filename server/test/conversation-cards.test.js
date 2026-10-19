// Room cards: owner-only, bound to room + target agent + live dispatch + exact request id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, addBot, member } from './bot-helpers.js';

const V12_HEADERS = { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1' };
const V11_HEADERS = { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1, foxfleet.bot.v1' };
const mentionOf = (text, id) => {
  const name = id.slice(6);
  const at = text.toLowerCase().indexOf('@' + name.toLowerCase());
  return { kind: 'agent', id, offset: at < 0 ? 0 : at, length: name.length + 1 };
};
const roomSend = async (h, id, text, agent = 'agent:helper', agent2) => {
  const mentions = agent2
    ? [mentionOf(text, agent), mentionOf(text, agent2)]
    : [mentionOf(text, agent)];
  const r = await h.call(`/api/conversations/${id}/messages`, { data: { text, mentions } });
  assert.equal(r.status, 202);
  return r.json();
};
const createRoom = async (h, title, member_ids, token = h.token) => {
  const r = await h.call('/api/conversations', { token, data: { title, member_ids } });
  assert.equal(r.status, 201);
  return r.json();
};
const attemptOf = (run) => ({ dispatch_id: run.dispatch_id, run_token: run.run_token });
const cardRoom = async (h, room) => JSON.parse(await readFile(path.join(h.dir, 'conversations', `${room.id}.json`), 'utf8'));
const apiAnswer = (h, agent, roomId, requestId, result, token = h.token) => h.call(
  `/api/agents/${agent}/native/sessions/${roomId}/requests/${requestId}`,
  { token, data: { result } },
);

test('a room card binds owner + room + target agent + dispatch + request id; the exact tap reaches only that bot', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Cards', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper ask me');
  const run = await c.next((x) => x.t === 'dispatch.run');

  const sent = await c.request({
    t: 'card.send', id: 'card-1', chat_id: room.id, kind: 'approval', instance: 'inst-a',
    command: 'rm -rf build', actor_kind: 'agent', idempotency_key: 'card-key-1',
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const requestId = sent.result.request_id;
  assert.match(requestId, /^frq_[A-Za-z0-9_-]{16}$/);

  const stored = await cardRoom(boot.h, room);
  const card = stored.cards.find((row) => row.id === requestId);
  assert.equal(card.owner_id, stored.owner_id);
  assert.equal(card.room_id, room.id);
  assert.equal(card.target_agent_id, 'agent:helper');
  assert.equal(card.dispatch_id, run.dispatch_id);
  assert.equal(card.run_token, run.run_token);
  assert.equal(card.state, 'open');

  const answered = await apiAnswer(boot.h, 'helper', room.id, requestId, { choice: 'once' });
  assert.equal(answered.status, 200, await answered.text());
  const callback = await c.next((x) => x.t === 'callback' && x.request_id === requestId);
  assert.equal(callback.chat_id, room.id);
  assert.equal(callback.chat_type, 'group');
  assert.equal(callback.thread_id, 'fcr_' + room.id.slice(3));
  assert.equal(callback.actor.kind, 'human');
  assert.equal(callback.actor.is_bot, false);
  assert.equal(callback.kind, 'approval');
  assert.deepEqual(callback.value, { choice: 'once' });

  const ack = await c.request({
    t: 'callback.answer', id: 'card-ack', callback_id: callback.callback_id,
    chat_id: room.id, thread_id: callback.thread_id, outcome: 'resolved',
  });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal((await apiAnswer(boot.h, 'helper', room.id, requestId, { choice: 'once' })).status, 404, 'a second tap is stale');
});

test('wrong room, wrong agent and a duplicate tap refuse instead of resolving another pending card', async (t) => {
  const boot = await bootBot(t);
  const reviewer = await addBot(t, boot.h, 'reviewer');
  const room = await createRoom(boot.h, 'One', ['helper', 'reviewer']);
  const other = await createRoom(boot.h, 'Two', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper first');
  const run = await c.next((x) => x.t === 'dispatch.run');
  const one = await c.request({ t: 'card.send', id: 'card-one', chat_id: room.id, kind: 'approval', instance: 'i1', command: 'one', actor_kind: 'agent' });
  const two = await c.request({ t: 'card.send', id: 'card-two', chat_id: room.id, kind: 'approval', instance: 'i2', command: 'two', actor_kind: 'agent' });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  const first = one.result.request_id, second = two.result.request_id;
  assert.notEqual(first, second);

  assert.equal((await apiAnswer(boot.h, 'helper', other.id, first, { choice: 'once' })).status, 404, 'cross-room');
  assert.equal((await apiAnswer(boot.h, 'reviewer', room.id, first, { choice: 'once' })).status, 404, 'wrong target agent');
  const ok = await apiAnswer(boot.h, 'helper', room.id, second, { choice: 'deny' });
  assert.equal(ok.status, 200);
  const callback = await c.next((x) => x.t === 'callback' && x.request_id === second);
  assert.ok(callback, 'the exact second request resolves');
  assert.equal((await apiAnswer(boot.h, 'helper', room.id, second, { choice: 'once' })).status, 404, 'no duplicate callback');

  const again = await c.request({ t: 'card.send', id: 'card-one-idem', chat_id: room.id, kind: 'approval', instance: 'i1', command: 'one', actor_kind: 'agent', idempotency_key: 'same-key' });
  const again2 = await c.request({ t: 'card.send', id: 'card-one-idem2', chat_id: room.id, kind: 'approval', instance: 'i1', command: 'one', actor_kind: 'agent', idempotency_key: 'same-key' });
  assert.equal(again.result.request_id, again2.result.request_id, 'idempotent card.send reuses the request');

  const conflict = await c.request({ t: 'card.send', id: 'card-conflict', chat_id: room.id, kind: 'approval', instance: 'i1', command: 'different', actor_kind: 'agent', idempotency_key: 'same-key' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'idempotency_conflict');
  assert.equal(run.dispatch_id.length > 0, true);
});

test('an agent message or guessed callback id cannot answer a card; only the owner HTTP tap arms a callback', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'No agent authority', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper open a card');
  const run = await c.next((x) => x.t === 'dispatch.run');
  const sent = await c.request({ t: 'card.send', id: 'card-x', chat_id: room.id, kind: 'approval', instance: 'ix', command: 'deploy', actor_kind: 'agent' });
  const requestId = sent.result.request_id;

  const text = await c.request({ t: 'message.send', id: 'claim-approved', chat_id: room.id, text: 'approved', final: true, ...attemptOf(run) });
  assert.equal(text.ok, true, 'the agent may speak, but only as text');
  assert.equal(c.texts.filter((x) => x && x.t === 'callback').length, 0, 'text never becomes a tap');
  const guessed = await c.request({
    t: 'callback.answer', id: 'guess', callback_id: 'fcb_' + 'A'.repeat(16),
    chat_id: room.id, thread_id: 'fcr_' + room.id.slice(3), outcome: 'resolved',
  });
  assert.equal(guessed.ok, false);
  assert.equal(guessed.error.code, 'not_found');

  assert.equal((await apiAnswer(boot.h, 'helper', room.id, requestId, { choice: 'once' })).status, 200);
  const callback = await c.next((x) => x.t === 'callback' && x.request_id === requestId);
  assert.equal(callback.callback_id.startsWith('fcb_'), true);
});

test('stop closes open room cards; a late answer and a late callback are refused', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Stop cards', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper hold');
  await c.next((x) => x.t === 'dispatch.run');
  const sent = await c.request({ t: 'card.send', id: 'card-stop', chat_id: room.id, kind: 'approval', instance: 'is', command: 'hold', actor_kind: 'agent' });
  const requestId = sent.result.request_id;

  const stopping = boot.h.call(`/api/conversations/${room.id}/stop`, { method: 'POST', data: {} });
  const stopFrame = await c.next((x) => x.t === 'chat.stop' && x.chat_id === room.id);
  assert.equal(stopFrame.chat_type, 'group');
  assert.equal(stopFrame.thread_id, 'fcr_' + room.id.slice(3));
  assert.equal(stopFrame.actor.kind, 'human');
  const answered = await c.request({
    t: 'callback.answer', id: 'stop-ack', callback_id: stopFrame.stop_id,
    chat_id: room.id, thread_id: stopFrame.thread_id, outcome: 'stopped',
  });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  const response = await stopping;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stopped, true);
  assert.equal(body.confirmed, true);
  assert.equal(body.cancelled_cards, 1);
  assert.equal(body.agents['agent:helper'], 'stopped');

  assert.equal((await apiAnswer(boot.h, 'helper', room.id, requestId, { choice: 'once' })).status, 404);
  const lateText = await c.request({ t: 'message.send', id: 'late-unbound', chat_id: room.id, text: 'late completion', final: true });
  assert.equal(lateText.ok, false);
  assert.equal(lateText.error.code, 'dispatch_stale', 'an unbound late completion cannot become plain room chatter');
  const ack = await c.request({
    t: 'callback.answer', id: 'late-card-ack', callback_id: 'fcb_' + 'B'.repeat(16),
    chat_id: room.id, thread_id: 'fcr_' + room.id.slice(3), outcome: 'resolved',
  });
  assert.equal(ack.ok, false);
  assert.equal(ack.error.code, 'not_found');
});

test('1.1 sockets never receive room stop/card frames and the HTTP RPC path stays the DM subset', async (t) => {
  const boot = await bootBot(t);
  const legacy = await addBot(t, boot.h, 'legacy');
  const room = await createRoom(boot.h, 'Legacy', ['helper', 'legacy']);
  const c = await boot.connect({ headers: V12_HEADERS });
  const old = await legacy.connect({ headers: V11_HEADERS });
  await c.next((x) => x.t === 'hello');
  await old.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper newer');
  await c.next((x) => x.t === 'dispatch.run');
  const sent = await c.request({ t: 'card.send', id: 'card-legacy', chat_id: room.id, kind: 'approval', instance: 'il', command: 'legacy', actor_kind: 'agent' });
  await apiAnswer(boot.h, 'helper', room.id, sent.result.request_id, { choice: 'once' });
  await c.next((x) => x.t === 'callback' && x.request_id === sent.result.request_id);
  assert.equal(old.texts.filter((x) => x && (x.t === 'callback' || x.t === 'chat.stop')).length, 0);

  const rpc = await fetch(boot.h.base + '/api/bot/rpc', {
    method: 'POST',
    headers: { Authorization: `Bot ${boot.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: 'card.send', id: 'http-card', chat_id: room.id, kind: 'approval', instance: 'ih', command: 'http', actor_kind: 'agent' }),
  });
  assert.equal(rpc.status, 200);
  const body = await rpc.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'unsupported');
});

test('a non-owner account cannot answer or stop this room', async (t) => {
  const boot = await bootBot(t);
  const alice = await member(boot.h, 'alice');
  const room = await createRoom(boot.h, 'Owner only', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper card');
  await c.next((x) => x.t === 'dispatch.run');
  const sent = await c.request({ t: 'card.send', id: 'card-owner', chat_id: room.id, kind: 'approval', instance: 'io', command: 'owner', actor_kind: 'agent' });
  const requestId = sent.result.request_id;

  // Alice's store cannot see this room or its card at all.
  assert.ok([403, 404].includes((await apiAnswer(boot.h, 'helper', room.id, requestId, { choice: 'once' }, alice.token)).status));
  assert.equal((await boot.h.call(`/api/conversations/${room.id}/stop`, { token: alice.token, method: 'POST', data: {} })).status, 404);
});


test('an owner tap that the bot never acknowledged is replayed on reconnect and only ack retires it', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Replay', ['helper']);
  let c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper card');
  await c.next((x) => x.t === 'dispatch.run');
  const sent = await c.request({ t: 'card.send', id: 'card-replay', chat_id: room.id, kind: 'approval', instance: 'ir', command: 'replay', actor_kind: 'agent' });
  const requestId = sent.result.request_id;
  c.end();
  assert.equal((await apiAnswer(boot.h, 'helper', room.id, requestId, { choice: 'once' })).status, 200);

  c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  const callback = await c.next((x) => x.t === 'callback' && x.request_id === requestId);
  const ack = await c.request({
    t: 'callback.answer', id: 'replay-ack', callback_id: callback.callback_id,
    chat_id: room.id, thread_id: callback.thread_id, outcome: 'resolved',
  });
  assert.equal(ack.ok, true, JSON.stringify(ack));

  c.end();
  c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(c.texts.filter((x) => x && x.t === 'callback' && x.request_id === requestId).length, 0);
});

test('a 1.1 reconnect never receives the group callback for a 1.2 room card', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Reconnect cards', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper card for reconnect');
  await c.next((x) => x.t === 'dispatch.run');
  const sent = await c.request({ t: 'card.send', id: 'card-reconnect', chat_id: room.id, kind: 'approval', instance: 'ir', command: 'reconnect', actor_kind: 'agent' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const requestId = sent.result.request_id;
  c.end();

  const old = await boot.connect({ headers: V11_HEADERS });
  await old.next((x) => x.t === 'hello');
  assert.equal((await apiAnswer(boot.h, 'helper', room.id, requestId, { choice: 'once' })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(old.texts.filter((x) => x && x.t === 'callback').length, 0,
    'a 1.1 socket is never handed a group callback');
  old.end();

  const back = await boot.connect({ headers: V12_HEADERS });
  await back.next((x) => x.t === 'hello');
  const callback = await back.next((x) => x.t === 'callback' && x.request_id === requestId);
  assert.ok(callback, 'the durable callback is replayed to the next 1.2 socket');
});

test('no room card can be minted during or after Stop until a new attempt', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Stop race cards', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper hold the turn');
  const held = await c.next((x) => x.t === 'dispatch.run');

  const stopping = boot.h.call(`/api/conversations/${room.id}/stop`, { method: 'POST', data: {} });
  const stopFrame = await c.next((x) => x.t === 'chat.stop' && x.chat_id === room.id);
  const during = await c.request({ t: 'card.send', id: 'card-during-stop', chat_id: room.id, kind: 'approval', instance: 'id', command: 'during', actor_kind: 'agent' });
  assert.equal(during.ok, false, 'a card minted while Stop is settling must be refused');
  await c.request({
    t: 'callback.answer', id: 'stop-race-ack', callback_id: stopFrame.stop_id,
    chat_id: room.id, thread_id: stopFrame.thread_id, outcome: 'stopped',
  });
  assert.equal((await stopping).status, 200);

  const after = await c.request({ t: 'card.send', id: 'card-after-stop', chat_id: room.id, kind: 'approval', instance: 'ia', command: 'after', actor_kind: 'agent' });
  assert.equal(after.ok, false, 'no live attempt means no card after Stop');
  assert.equal((await boot.h.call(`/api/conversations/${room.id}/resume`, { method: 'POST', data: {} })).status, 200);
  const resumed = await c.request({ t: 'card.send', id: 'card-after-resume', chat_id: room.id, kind: 'approval', instance: 'ir', command: 'resume', actor_kind: 'agent' });
  assert.equal(resumed.ok, false, 'resume alone is not a new attempt');

  await roomSend(boot.h, room.id, '@helper fresh attempt');
  await c.next((x) => x.t === 'dispatch.run' && x.dispatch_id !== held.dispatch_id);
  const fresh = await c.request({ t: 'card.send', id: 'card-new-attempt', chat_id: room.id, kind: 'approval', instance: 'in', command: 'new', actor_kind: 'agent' });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
});
