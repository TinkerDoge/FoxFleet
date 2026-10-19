// Room HTTP surface: the openapi routes, account isolation on every route and the frozen error codes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootHub, member, PW } from './bot-helpers.js';

const json = async (res) => ({ status: res.status, body: await res.json() });
const addAgent = async (h, token, name) => {
  const r = await h.call('/api/connections', { token, data: { kind: 'hermes', name, host: '127.0.0.1' } });
  assert.equal(r.status, 201, `agent ${name}`);
};
const createRoom = async (h, { token = h.token, title = 'Team', member_ids } = {}) => {
  const r = await json(await h.call('/api/conversations', { token, data: { title, ...(member_ids ? { member_ids } : {}) } }));
  assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
};
const send = async (h, id, data, token = h.token) => json(await h.call(`/api/conversations/${id}/messages`, { token, data }));

test('wrong account on every conversation route is a non-enumerating 404; list never leaks', async (t) => {
  const h = await bootHub(t);
  await addAgent(h, h.token, 'alpha');
  const alice = await member(h, 'alice');
  await addAgent(h, alice.token, 'beta');
  const room = await createRoom(h, { member_ids: ['alpha'] });
  const sent = await send(h, room.id, { text: 'private' });
  assert.equal(sent.status, 202);
  const messageId = sent.body.message.id;

  const list = await json(await h.call('/api/conversations', { token: alice.token }));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.conversations, []);
  assert.equal(list.body.total, 0);

  const routes = [
    ['GET', `/api/conversations/${room.id}`],
    ['PATCH', `/api/conversations/${room.id}`, { title: 'stolen' }],
    ['PUT', `/api/conversations/${room.id}/members/beta`],
    ['DELETE', `/api/conversations/${room.id}/members/alpha`],
    ['GET', `/api/conversations/${room.id}/messages`],
    ['POST', `/api/conversations/${room.id}/messages`, { text: 'intrude' }],
    ['GET', `/api/conversations/${room.id}/messages/${messageId}`],
    ['POST', `/api/conversations/${room.id}/read`, {}],
    ['PUT', `/api/conversations/${room.id}/preferences`, { muted: true }],
  ];
  for (const [method, route, data] of routes) {
    const r = await h.call(route, { token: alice.token, method, ...(data === undefined ? {} : { data }) });
    assert.equal(r.status, 404, `${method} ${route}`);
    const body = await r.json();
    assert.equal(body.code, 'conversation_not_found', `${method} ${route}: ${JSON.stringify(body)}`);
  }
  // Another account cannot name this account's agent as a member, even in its own room.
  const own = await createRoom(h, { token: alice.token, title: 'Alice room' });
  const steal = await h.call(`/api/conversations/${own.id}/members/alpha`, { token: alice.token, method: 'PUT' });
  assert.equal(steal.status, 404); assert.equal((await steal.json()).code, 'agent_not_in_account');
  // No DM/ledger store was created by the room feature.
  assert.ok(!(await readdir(h.dir)).includes('chats.json'));
});

test('invalid and prototype-like ids stay 4xx, never 500', async (t) => {
  const h = await bootHub(t);
  await addAgent(h, h.token, 'alpha');
  const room = await createRoom(h);
  const ids = ['__proto__', 'constructor', 'prototype', 'fc_short', '..%2Fescape'];
  for (const id of ids) {
    for (const [method, route, data] of [
      ['GET', `/api/conversations/${id}`], ['PATCH', `/api/conversations/${id}`, { title: 'x' }],
      ['GET', `/api/conversations/${id}/messages`], ['POST', `/api/conversations/${id}/messages`, { text: 'x' }],
      ['GET', `/api/conversations/${id}/messages/__proto__`], ['POST', `/api/conversations/${id}/read`, {}],
      ['PUT', `/api/conversations/${id}/preferences`, { muted: true }],
    ]) {
      const r = await h.call(route, { method, ...(data === undefined ? {} : { data }) });
      assert.equal(r.status, 404, `${method} ${route}`);
    }
  }
  for (const agentId of ['__proto__', 'constructor', 'prototype']) {
    const r = await h.call(`/api/conversations/${room.id}/members/${agentId}`, { method: 'PUT' });
    assert.equal(r.status, 404, agentId); assert.equal((await r.json()).code, 'agent_not_in_account');
  }
  const r = await h.call(`/api/conversations/${room.id}/messages/constructor`);
  assert.equal(r.status, 404);
});

test('membership: owner-only changes, unknown agents, duplicates and removal/rejoin generation', async (t) => {
  const h = await bootHub(t);
  await addAgent(h, h.token, 'alpha');
  await addAgent(h, h.token, 'beta');
  const room = await createRoom(h, { member_ids: ['alpha'] });
  assert.deepEqual(room.members.map((m) => m.id), ['agent:alpha']);

  const dup = await h.call(`/api/conversations/${room.id}/members/alpha`, { method: 'PUT' });
  assert.equal(dup.status, 409); assert.equal((await dup.json()).code, 'member_exists');
  const unknown = await h.call(`/api/conversations/${room.id}/members/nobody`, { method: 'PUT' });
  assert.equal(unknown.status, 404); assert.equal((await unknown.json()).code, 'agent_not_in_account');
  const added = await json(await h.call(`/api/conversations/${room.id}/members/beta`, { method: 'PUT' }));
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.members.map((m) => m.id).sort(), ['agent:alpha', 'agent:beta']);

  const removed = await json(await h.call(`/api/conversations/${room.id}/members/alpha`, { method: 'DELETE' }));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.members.map((m) => m.id), ['agent:beta']);
  const missing = await h.call(`/api/conversations/${room.id}/members/alpha`, { method: 'DELETE' });
  assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'member_not_found');

  const rejoined = await json(await h.call(`/api/conversations/${room.id}/members/alpha`, { method: 'PUT' }));
  assert.equal(rejoined.status, 200);
  assert.deepEqual(rejoined.body.members.map((m) => m.id).sort(), ['agent:alpha', 'agent:beta']);
  const disk = JSON.parse(await readFile(path.join(h.dir, 'conversations', `${room.id}.json`), 'utf8'));
  const rows = disk.members.filter((m) => m.actor_id === 'agent:alpha');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].generation, 1); assert.equal(rows[1].generation, 2);
  assert.ok(rows[0].removed_at); assert.equal(rows[1].removed_at, null);
});

test('create/rename validate titles; names are JSON data, control characters are refused', async (t) => {
  const h = await bootHub(t);
  for (const title of ['', 'x'.repeat(257), 'bad\u0001title']) {
    const r = await h.call('/api/conversations', { data: { title } });
    assert.equal(r.status, 400); assert.equal((await r.json()).code, 'invalid_title');
  }
  const title = '<img src=x onerror=alert(1)> & "quoted"';
  const room = await createRoom(h, { title });
  assert.equal(room.title, title);
  const patch = await json(await h.call(`/api/conversations/${room.id}`, { method: 'PATCH', data: { title: '<script>alert(1)</script>' } }));
  assert.equal(patch.status, 200); assert.equal(patch.body.title, '<script>alert(1)</script>');
  const bad = await h.call(`/api/conversations/${room.id}`, { method: 'PATCH', data: { title: 'bad\u007ftitle' } });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'invalid_title');
});

test('messages: send, keyset paging, replies, mentions, idempotency and single read', async (t) => {
  const h = await bootHub(t);
  await addAgent(h, h.token, 'alpha');
  const room = await createRoom(h, { member_ids: ['alpha'] });
  const first = await send(h, room.id, { text: 'hello' });
  assert.equal(first.status, 202);
  assert.equal(first.body.conversation_id, room.id);
  assert.deepEqual(first.body.dispatched_to, []);
  assert.equal(first.body.message.text, 'hello');
  assert.equal(first.body.message.sender.kind, 'human');
  assert.equal(first.body.message.sender.is_bot, false);

  const text = 'hi @alpha';
  const mention = { kind: 'agent', id: 'agent:alpha', offset: text.indexOf('@alpha'), length: 6 };
  const second = await send(h, room.id, { text, mentions: [mention], reply_to: first.body.message.id });
  assert.equal(second.status, 202);
  assert.deepEqual(second.body.message.mentions, [mention]);
  assert.equal(second.body.message.reply_to, first.body.message.id);

  const foreign = await createRoom(h, { title: 'Other' });
  const elsewhere = await send(h, foreign.id, { text: 'elsewhere' });
  const cross = await send(h, room.id, { text: 'x', reply_to: elsewhere.body.message.id });
  assert.equal(cross.status, 404); assert.equal(cross.body.code, 'cross_room_reply');
  const missing = await send(h, room.id, { text: 'x', reply_to: 'fm_AAAAAAAAAAAAAAAA' });
  assert.equal(missing.status, 404); assert.equal(missing.body.code, 'reply_not_found');
  const badMention = await send(h, room.id, { text: 'hi', mentions: [{ kind: 'agent', id: 'agent:nobody', offset: 0, length: 2 }] });
  assert.equal(badMention.status, 404); assert.equal(badMention.body.code, 'unknown_mention');

  for (const text2 of ['two', 'three', 'four']) await send(h, room.id, { text: text2 });
  const page = await json(await h.call(`/api/conversations/${room.id}/messages?limit=2`));
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.messages.map((m) => m.text), ['three', 'four']);
  assert.equal(page.body.has_more, true);
  const older = await json(await h.call(`/api/conversations/${room.id}/messages?limit=10&before=${page.body.messages[0].seq}`));
  assert.deepEqual(older.body.messages.map((m) => m.text), ['hello', 'hi @alpha', 'two']);
  assert.equal(older.body.has_more, false);
  const one = await json(await h.call(`/api/conversations/${room.id}/messages/${first.body.message.id}`));
  assert.equal(one.status, 200); assert.equal(one.body.text, 'hello');

  const once = await send(h, room.id, { text: 'idem', client_id: 'client-1' });
  const twice = await send(h, room.id, { text: 'idem', client_id: 'client-1' });
  assert.equal(twice.status, 202); assert.equal(twice.body.message.id, once.body.message.id);
  const clash = await send(h, room.id, { text: 'different', client_id: 'client-1' });
  assert.equal(clash.status, 409); assert.equal(clash.body.code, 'idempotency_conflict');

  const createIdem = await h.call('/api/conversations', { data: { title: 'Once', client_id: 'create-1' } });
  assert.equal(createIdem.status, 201);
  const createAgain = await h.call('/api/conversations', { data: { title: 'Once', client_id: 'create-1' } });
  assert.equal(createAgain.status, 201); assert.equal((await createAgain.json()).id, (await createIdem.json()).id);
});

test('read/preferences are per device and reflect in the conversation view', async (t) => {
  const h = await bootHub(t);
  const room = await createRoom(h);
  const login = await h.call('/api/auth/login', { token: '', data: { username: 'owner1', password: PW, client: 'app' } });
  assert.equal(login.status, 200);
  const phoneToken = (await login.json()).token;

  const read = await json(await h.call(`/api/conversations/${room.id}/read`, { token: phoneToken, data: {} }));
  assert.equal(read.status, 200); assert.equal(read.body.unread_count, 0);
  const prefs = await json(await h.call(`/api/conversations/${room.id}/preferences`, { token: phoneToken, method: 'PUT', data: { muted: true, archived: true, notify: 'mentions' } }));
  assert.equal(prefs.status, 200); assert.deepEqual(prefs.body, { muted: true, archived: true, notify: 'mentions' });
  assert.equal((await json(await h.call(`/api/conversations/${room.id}`, { token: phoneToken }))).body.archived, true);
  assert.equal((await json(await h.call(`/api/conversations/${room.id}`))).body.archived, false, 'the other device is unaffected');
  for (const data of [{ muted: 'yes' }, { notify: 'loud' }, { archived: 1 }]) {
    assert.equal((await h.call(`/api/conversations/${room.id}/preferences`, { method: 'PUT', data })).status, 400);
  }
});

test('restart keeps the shared transcript; stop/resume stay unregistered (Task 5)', async (t) => {
  const h = await bootHub(t);
  await addAgent(h, h.token, 'alpha');
  const room = await createRoom(h, { title: 'Durable', member_ids: ['alpha'] });
  const sent = await send(h, room.id, { text: 'survives restart' });
  assert.equal(sent.status, 202);
  await h.restart();
  const again = await json(await h.call(`/api/conversations/${room.id}`));
  assert.equal(again.status, 200); assert.equal(again.body.title, 'Durable');
  assert.deepEqual(again.body.members.map((m) => m.id), ['agent:alpha']);
  const page = await json(await h.call(`/api/conversations/${room.id}/messages`));
  assert.deepEqual(page.body.messages.map((m) => m.text), ['survives restart']);
  assert.equal((await h.call(`/api/conversations/${room.id}/stop`, { method: 'POST', data: {} })).status, 404);
  assert.equal((await h.call(`/api/conversations/${room.id}/resume`, { method: 'POST', data: {} })).status, 404);
});

test('corrupt room file is refused at the HTTP boundary too (503, no repair)', async (t) => {
  const h = await bootHub(t);
  const room = await createRoom(h);
  await writeFile(path.join(h.dir, 'conversations', `${room.id}.json`), '{broken');
  await h.restart();
  const r = await h.call('/api/conversations');
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.code, 'bot_store_unavailable');
});
