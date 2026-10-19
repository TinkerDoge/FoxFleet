// Room storage: per-account conversation files, transactional room writes, filtering before paging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conversationStore } from '../conversation-store.js';

const OWNER = { id: 'u_owner', name: 'owner' };
const ALPHA = { actor_id: 'agent:alpha', name: 'Alpha' };
const BETA = { actor_id: 'agent:beta', name: 'Beta' };
const actor = { kind: 'human', id: OWNER.id, name: OWNER.name };

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-rooms-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
async function seed(t, options = {}) {
  const dir = await temp(t);
  const store = conversationStore(dir, options);
  await store.ready();
  t.after(() => store.idle());
  return { dir, store };
}
const create = (store, title = 'Room', agents = [ALPHA, BETA]) => store.create({ owner: OWNER, title, agents });

test('creation/list: a room exposes the frozen Conversation shape; list is newest first', async (t) => {
  const { store } = await seed(t);
  const first = await create(store, 'First', [ALPHA]);
  await new Promise((r) => setTimeout(r, 2));
  const second = await create(store, 'Second', []);

  assert.match(first.id, /^fc_[A-Za-z0-9_-]{16}$/);
  assert.match(first.thread_id, /^fcr_[A-Za-z0-9_-]{16}$/);
  assert.equal(first.chat_type, 'group');
  assert.equal(first.title, 'First');
  assert.deepEqual(first.owner, { id: OWNER.id, name: OWNER.name, kind: 'human', is_bot: false, joined_at: first.created_at });
  assert.deepEqual(first.members.map((m) => [m.id, m.name, m.kind, m.is_bot]), [['agent:alpha', 'Alpha', 'agent', true]]);
  assert.equal(typeof first.created_at, 'number');
  assert.equal(typeof first.updated_at, 'number');
  assert.equal(first.last_message_at, null);
  assert.equal(first.unread_count, 0);

  const list = await store.list({ device: 'd1', limit: 10, offset: 0 });
  assert.equal(list.total, 2);
  assert.deepEqual(list.conversations.map((c) => c.id), [second.id, first.id]);

  await assert.rejects(() => store.create({ owner: OWNER, title: '' }), (e) => e.status === 400 && e.code === 'invalid_title');
  await assert.rejects(() => store.create({ owner: OWNER, title: 'x'.repeat(257) }), (e) => e.code === 'invalid_title');
  await assert.rejects(() => store.create({ owner: OWNER, title: 'bad\u0001title' }), (e) => e.code === 'invalid_title');
});

test('membership: add/remove, removal revokes, re-joining mints a new generation', async (t) => {
  const { dir, store } = await seed(t);
  const room = await create(store, 'Team', []);
  const joined = await store.addMember(room.id, { ownerId: OWNER.id, agent: ALPHA });
  assert.deepEqual(joined.members.map((m) => m.id), ['agent:alpha']);
  await assert.rejects(() => store.addMember(room.id, { ownerId: OWNER.id, agent: ALPHA }), (e) => e.status === 409 && e.code === 'member_exists');

  const left = await store.removeMember(room.id, { ownerId: OWNER.id, agentId: 'agent:alpha' });
  assert.deepEqual(left.members, []);
  await assert.rejects(() => store.removeMember(room.id, { ownerId: OWNER.id, agentId: 'alpha' }), (e) => e.status === 404 && e.code === 'member_not_found');

  const again = await store.addMember(room.id, { ownerId: OWNER.id, agent: ALPHA });
  assert.deepEqual(again.members.map((m) => m.id), ['agent:alpha']);
  const disk = JSON.parse(await readFile(path.join(dir, `${room.id}.json`), 'utf8'));
  const alphaRows = disk.members.filter((m) => m.actor_id === 'agent:alpha');
  assert.equal(alphaRows.length, 2, 'the removed membership row is retained');
  assert.equal(alphaRows[0].generation, 1);
  assert.equal(alphaRows[1].generation, 2);
  assert.equal(alphaRows[1].removed_at, null);
  assert.notEqual(alphaRows[0].removed_at, null);

  await assert.rejects(() => store.addMember(room.id, { ownerId: 'someone_else', agent: BETA }), (e) => e.status === 403 && e.code === 'not_conversation_owner');
  await assert.rejects(() => store.rename(room.id, { ownerId: 'someone_else', title: 'x' }), (e) => e.code === 'not_conversation_owner');
});

test('message paging/replies: keyset seq cursor, newest page, reply root in the same room', async (t) => {
  const { store } = await seed(t);
  const room = await create(store, 'Talk');
  const sent = [];
  for (const text of ['one', 'two', 'three', 'four', 'five']) sent.push((await store.send(room.id, { actor, text })).message);
  assert.deepEqual(sent.map((m) => m.text), ['one', 'two', 'three', 'four', 'five']);
  assert.match(sent[0].id, /^fm_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(sent[0].sender, { id: OWNER.id, name: OWNER.name, kind: 'human', is_bot: false, joined_at: (await store.get(room.id, { device: 'd' })).created_at });
  assert.equal(sent[0].reply_to, null);

  const page1 = await store.messages(room.id, { device: 'd', limit: 2, offset: 0 });
  assert.deepEqual(page1.messages.map((m) => m.text), ['four', 'five']);
  assert.equal(page1.has_more, true);
  assert.equal(page1.next_cursor, sent[3].seq);
  const page2 = await store.messages(room.id, { device: 'd', limit: 2, before: 4 });
  assert.deepEqual(page2.messages.map((m) => m.text), ['two', 'three']);
  assert.equal(page2.has_more, true);
  const page3 = await store.messages(room.id, { device: 'd', limit: 2, before: 2 });
  assert.deepEqual(page3.messages.map((m) => m.text), ['one']);
  assert.equal(page3.has_more, false);

  const reply = (await store.send(room.id, { actor, text: 'reply', reply_to: sent[0].id })).message;
  assert.equal(reply.reply_to, sent[0].id);
  assert.equal((await store.message(room.id, reply.id, { device: 'd' })).text, 'reply');
  assert.equal(reply.root_id, sent[0].id);
  const nested = (await store.send(room.id, { actor, text: 'nested', reply_to: reply.id })).message;
  assert.equal(nested.root_id, sent[0].id);

  const other = await create(store, 'Other');
  const foreign = (await store.send(other.id, { actor, text: 'elsewhere' })).message;
  await assert.rejects(() => store.send(room.id, { actor, text: 'x', reply_to: foreign.id }), (e) => e.status === 404 && e.code === 'cross_room_reply');
  await assert.rejects(() => store.send(room.id, { actor, text: 'x', reply_to: 'fm_AAAAAAAAAAAAAAAA' }), (e) => e.status === 404 && e.code === 'reply_not_found');
  await assert.rejects(() => store.send(room.id, { actor, text: 'x', reply_to: '__proto__' }), (e) => e.status === 404 && e.code === 'reply_not_found');
});

test('reasoning: an agent message keeps its thinking, a human message never does, an oversize block is clipped', async (t) => {
  const { store } = await seed(t);
  const room = await create(store, 'Thinking', [ALPHA]);
  const agent = { kind: 'agent', id: ALPHA.actor_id, name: ALPHA.name };

  const said = (await store.send(room.id, { actor: agent, text: 'here it is', reasoning: 'Let me check the logs.' })).message;
  assert.equal(said.reasoning, 'Let me check the logs.');
  assert.equal(said.reasoning_truncated, undefined);
  const page = await store.messages(room.id, { device: 'd', limit: 10 });
  assert.equal(page.messages.find((m) => m.id === said.id).reasoning, 'Let me check the logs.');

  // A human has no thinking block, even when one is offered.
  const mine = (await store.send(room.id, { actor, text: 'mine', reasoning: 'not mine' })).message;
  assert.equal(mine.reasoning, undefined);
  assert.equal((await store.messages(room.id, { device: 'd', limit: 10 })).messages.find((m) => m.id === mine.id).reasoning, undefined);

  // Oversize: the thinking is clipped, the answer is never lost over a display field.
  const loud = (await store.send(room.id, { actor: agent, text: 'still here', reasoning: 'x'.repeat(70_000) })).message;
  assert.equal(loud.text, 'still here');
  assert.equal(loud.reasoning_truncated, true);
  assert.ok(Buffer.byteLength(loud.reasoning, 'utf8') <= 64 * 1024);
  assert.ok(loud.reasoning.length < 70_000);
});

test('mentions: UTF-16 spans, membership and overlap are checked; valid entities are stored verbatim', async (t) => {
  const { store } = await seed(t);
  const room = await create(store, 'Mentions', [ALPHA]);
  const text = 'hi 🤖 @alpha';
  const at = text.indexOf('@alpha');
  const ok = (await store.send(room.id, { actor, text, mentions: [{ kind: 'agent', id: 'agent:alpha', offset: at, length: 6 }] })).message;
  assert.deepEqual(ok.mentions, [{ kind: 'agent', id: 'agent:alpha', offset: at, length: 6 }]);

  await assert.rejects(() => store.send(room.id, { actor, text: 'hi', mentions: [{ kind: 'agent', id: 'agent:alpha', offset: 0, length: 3 }] }), (e) => e.code === 'mentions_invalid');
  await assert.rejects(() => store.send(room.id, { actor, text: 'hi', mentions: [{ kind: 'agent', id: 'agent:nobody', offset: 0, length: 2 }] }), (e) => e.status === 404 && e.code === 'unknown_mention');
  await assert.rejects(() => store.send(room.id, { actor, text: 'abc', mentions: [{ kind: 'agent', id: 'agent:alpha', offset: 0, length: 2 }, { kind: 'agent', id: 'agent:alpha', offset: 1, length: 2 }] }), (e) => e.code === 'mentions_invalid');
  await assert.rejects(() => store.send(room.id, { actor, text: '🤖', mentions: [{ kind: 'agent', id: 'agent:alpha', offset: 1, length: 1 }] }), (e) => e.code === 'mentions_invalid', 'a span cannot start on a low surrogate');
  await assert.rejects(() => store.send(room.id, { actor, text: 'x', mentions: 'nope' }), (e) => e.code === 'mentions_invalid');
  await assert.rejects(() => store.send(room.id, { actor, text: 'x', mentions: Array.from({ length: 65 }, () => ({ kind: 'agent', id: 'agent:alpha', offset: 0, length: 1 })) }), (e) => e.code === 'mentions_invalid');
});

test('mentions: a unique display-name id aliases to the member actor_id', async (t) => {
  const { store } = await seed(t);
  const native = { actor_id: 'agent:sumi-native', name: 'Sumi' };
  const room = await create(store, 'Native', [native]);
  const text = '@Sumi check this';
  const sent = (await store.send(room.id, {
    actor, text, mentions: [{ kind: 'agent', id: 'agent:Sumi', offset: 0, length: 5 }],
  })).message;
  assert.deepEqual(sent.mentions, [{ kind: 'agent', id: 'agent:sumi-native', offset: 0, length: 5 }]);
  const lower = (await store.send(room.id, {
    actor, text: '@sumi too', mentions: [{ kind: 'agent', id: 'agent:sumi', offset: 0, length: 5 }],
  })).message;
  assert.equal(lower.mentions[0].id, 'agent:sumi-native');
  const exact = (await store.send(room.id, {
    actor, text: '@Sumi exact', mentions: [{ kind: 'agent', id: 'agent:sumi-native', offset: 0, length: 5 }],
  })).message;
  assert.equal(exact.mentions[0].id, 'agent:sumi-native');
});

test('idempotency: create and send are keyed by client_id; a changed payload is a conflict', async (t) => {
  const { store } = await seed(t);
  const one = await store.create({ owner: OWNER, title: 'Idem', agents: [ALPHA], client_id: 'create-1' });
  const again = await store.create({ owner: OWNER, title: 'Idem', agents: [ALPHA], client_id: 'create-1' });
  assert.equal(again.id, one.id);
  await assert.rejects(() => store.create({ owner: OWNER, title: 'Different', agents: [ALPHA], client_id: 'create-1' }), (e) => e.status === 409 && e.code === 'conversation_exists');

  const first = await store.send(one.id, { actor, text: 'once', client_id: 'msg-1' });
  const second = await store.send(one.id, { actor, text: 'once', client_id: 'msg-1' });
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  await assert.rejects(() => store.send(one.id, { actor, text: 'changed', client_id: 'msg-1' }), (e) => e.status === 409 && e.code === 'idempotency_conflict');
  assert.equal((await store.messages(one.id, { device: 'd', limit: 10 })).messages.length, 1);
});

test('read/preferences: per-device read state, unread count and preferences persist in the room file', async (t) => {
  const { dir, store } = await seed(t);
  const room = await create(store, 'Reads');
  for (const text of ['a', 'b', 'c']) await store.send(room.id, { actor, text });
  let view = await store.get(room.id, { device: 'phone' });
  assert.equal(view.unread_count, 0, 'own human messages are not unread');
  await store.send(room.id, { actor: { kind: 'agent', id: 'agent:alpha', name: 'Alpha' }, text: 'reply' });
  view = await store.get(room.id, { device: 'phone' });
  assert.equal(view.unread_count, 1);
  view = await store.read(room.id, { device: 'phone', up_to: 2 });
  assert.equal(view.unread_count, 1);
  view = await store.read(room.id, { device: 'phone' });
  assert.equal(view.unread_count, 0);
  assert.equal((await store.get(room.id, { device: 'tablet' })).unread_count, 1, 'read state is per device');

  const prefs = await store.setPreferences(room.id, { device: 'phone', preferences: { muted: true, notify: 'mentions', archived: true, pinned: true } });
  assert.deepEqual(prefs, { muted: true, notify: 'mentions', archived: true, pinned: true });
  assert.equal((await store.get(room.id, { device: 'phone' })).archived, true);
  assert.equal((await store.get(room.id, { device: 'tablet' })).archived, false);
  await assert.rejects(() => store.setPreferences(room.id, { device: 'phone', preferences: { notify: 'loud' } }), (e) => e.status === 400);
  await assert.rejects(() => store.setPreferences(room.id, { device: 'phone', preferences: { muted: 'yes' } }), (e) => e.status === 400);

  const disk = JSON.parse(await readFile(path.join(dir, `${room.id}.json`), 'utf8'));
  assert.equal(disk.reads.find((r) => r.device_id === 'phone').at > 0, true);
});

test('hidden/deleted filtering happens before paging and single reads', async (t) => {
  const { store } = await seed(t);
  const room = await create(store, 'Filtering');
  const sent = [];
  for (const text of ['one', 'two', 'three', 'four', 'five']) sent.push((await store.send(room.id, { actor, text })).message);
  await store.hideMessage(room.id, { device: 'phone', messageId: sent[4].id, hidden: true });
  await store.deleteMessage(room.id, { messageId: sent[3].id, actorId: OWNER.id });

  const page = await store.messages(room.id, { device: 'phone', limit: 2, offset: 0 });
  assert.deepEqual(page.messages.map((m) => m.text), ['two', 'three']);
  assert.equal(page.has_more, true);
  const older = await store.messages(room.id, { device: 'phone', limit: 2, before: page.messages[0].seq });
  assert.deepEqual(older.messages.map((m) => m.text), ['one']);
  assert.equal(older.has_more, false);
  const otherDevice = await store.messages(room.id, { device: 'tablet', limit: 10 });
  assert.deepEqual(otherDevice.messages.map((m) => m.text), ['one', 'two', 'three', 'five']);
  await assert.rejects(() => store.message(room.id, sent[3].id, { device: 'phone' }), (e) => e.status === 404);
});

test('persisted restart: a second store reads the shared transcript from disk', async (t) => {
  const { dir, store } = await seed(t);
  const room = await create(store, 'Durable', [ALPHA]);
  const sent = (await store.send(room.id, { actor, text: 'survives' })).message;
  await store.read(room.id, { device: 'phone' });
  await store.idle();

  const reopened = conversationStore(dir);
  const view = await reopened.get(room.id, { device: 'phone' });
  assert.equal(view.title, 'Durable');
  assert.deepEqual(view.members.map((m) => m.id), ['agent:alpha']);
  const page = await reopened.messages(room.id, { device: 'phone', limit: 10 });
  assert.deepEqual(page.messages.map((m) => [m.id, m.text]), [[sent.id, 'survives']]);
  assert.equal((await reopened.list({ device: 'phone' })).total, 1);
  await reopened.idle();
});

test('corrupt-file refusal: a malformed room file makes the account store unavailable, never repaired', async (t) => {
  const { dir, store } = await seed(t);
  const room = await create(store, 'Broken');
  await store.idle();
  const file = path.join(dir, `${room.id}.json`);
  await writeFile(file, '{not json');
  const reopened = conversationStore(dir);
  await assert.rejects(() => reopened.ready(), (e) => e.status === 503);
  await assert.rejects(() => reopened.list({ device: 'd' }), (e) => e.status === 503);
  assert.equal(await readFile(file, 'utf8'), '{not json', 'the corrupt file is left as found');
});

test('failed disk write leaves memory uncommitted', async (t) => {
  const { dir, store } = await seed(t);
  const room = await create(store, 'Atomic');
  await store.send(room.id, { actor, text: 'committed' });
  await store.idle();
  const file = path.join(dir, `${room.id}.json`);
  await rm(file);
  await mkdir(file);
  await assert.rejects(() => store.send(room.id, { actor, text: 'lost' }), (e) => e.status === 503);
  const page = await store.messages(room.id, { device: 'd', limit: 10 });
  assert.deepEqual(page.messages.map((m) => m.text), ['committed']);
});

test('invalid and prototype-like ids are a clean not-found, never a 500', async (t) => {
  const { store } = await seed(t);
  const room = await create(store, 'Safe');
  for (const id of ['__proto__', 'constructor', 'prototype', 'fc_short', '../escape', 'fc_AAAAAAAAAAAAAAAA\u0000']) {
    await assert.rejects(() => store.get(id, { device: 'd' }), (e) => e.status === 404 && e.code === 'conversation_not_found');
    await assert.rejects(() => store.send(id, { actor, text: 'x' }), (e) => e.status === 404 && e.code === 'conversation_not_found');
  }
  await assert.rejects(() => store.removeMember(room.id, { ownerId: OWNER.id, agentId: '__proto__' }), (e) => e.status === 404 && e.code === 'member_not_found');
  await assert.rejects(() => store.message(room.id, '__proto__', { device: 'd' }), (e) => e.status === 404);
});

test('title/author text is stored as data and control characters are rejected', async (t) => {
  const { store } = await seed(t);
  const title = '<img src=x onerror=alert(1)> & "quoted"';
  const room = await create(store, title);
  assert.equal(room.title, title);
  const badName = { kind: 'human', id: OWNER.id, name: 'bad\u0000name' };
  const room2 = await create(store, 'Names');
  await assert.rejects(() => store.send(room2.id, { actor: badName, text: 'x' }), (e) => e.status === 400);
});
