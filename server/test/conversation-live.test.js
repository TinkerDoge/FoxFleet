// Room live events and notifications (Task 6): room-scoped replay/gap, one durable event per room message,
// per-room mute, and typing that is never stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootBot, addBot, sseReader } from './bot-helpers.js';

const V12 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const V11 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=', 'base64');
const roomId = async (h, title = 'Live') => {
  const r = await h.call('/api/conversations', { data: { title, member_ids: ['helper'] } });
  assert.equal(r.status, 201);
  return r.json();
};
const upload = (h, id, bytes = PNG) => fetch(h.base + `/api/conversations/${id}/media`, {
  method: 'POST', headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Name': 'picture.png' }, body: bytes,
});
const send = (h, id, data) => h.call(`/api/conversations/${id}/messages`, { data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('room live events replay per room with the attachment; typing is ephemeral; 1.1 gets no group frames', async (t) => {
  const boot = await bootBot(t), h = boot.h;
  const one = await roomId(h, 'One'), two = await roomId(h, 'Two');
  const row = await (await upload(h, one.id)).json();
  const before = await (await h.call('/api/chats')).json();

  const stream = sseReader(await h.call(`/api/live/stream?v=2&conversation_id=${one.id}&since=${encodeURIComponent(before.cursor)}`));
  t.after(() => stream.cancel());
  assert.equal((await send(h, one.id, { text: 'only one', media: [row.id] })).status, 202);
  const ev = await stream.next((e) => e.event === 'conversation.message.new');
  assert.equal(ev.data.conversation_id, one.id);
  assert.equal(ev.data.message.media[0].id, row.id);
  await send(h, two.id, { text: 'only two' });
  await sleep(100);
  assert.equal(stream.events.filter((e) => e.data?.conversation_id === two.id).length, 0, 'the stream is room-scoped');
  await stream.cancel();

  // Reconnect from a cursor: the missed room event replays, another room never appears.
  const cursor = (await (await h.call(`/api/live/events?since=${encodeURIComponent(before.cursor)}&conversation_id=${one.id}`)).json()).cursor;
  await send(h, two.id, { text: 'later two' });
  const missed = await send(h, one.id, { text: 'later one' });
  assert.equal(missed.status, 202);
  const pull = await (await h.call(`/api/live/events?since=${encodeURIComponent(cursor)}&conversation_id=${one.id}`)).json();
  assert.deepEqual(pull.events.map((e) => e.conversation_id), [one.id]);
  const history = await (await h.call(`/api/conversations/${one.id}/messages`)).json();
  assert.deepEqual(pull.events.map((e) => e.message.id), [history.messages.at(-1).id]);

  const roomStream = sseReader(await h.call(`/api/live/stream?v=2&conversation_id=${one.id}&since=${encodeURIComponent(cursor)}`));
  t.after(() => roomStream.cancel());
  assert.equal((await roomStream.next((e) => e.event === 'conversation.message.new')).data.message.id, history.messages.at(-1).id);
  await roomStream.cancel();

  const c = await boot.connect(V12);
  await c.next((x) => x.t === 'hello');
  const typingCursor = (await (await h.call(`/api/live/events?since=${encodeURIComponent(before.cursor)}&conversation_id=${one.id}`)).json()).cursor;
  const typing = sseReader(await h.call(`/api/live/stream?v=2&conversation_id=${one.id}&since=${encodeURIComponent(typingCursor)}`));
  t.after(() => typing.cancel());
  assert.equal((await c.request({ t: 'chat.action', id: 'typing', chat_id: one.id, action: 'typing' })).ok, true);
  const eph = await typing.next((e) => e.event === 'conversation.typing');
  assert.equal(eph.data.conversation_id, one.id);
  assert.equal(eph.id, undefined, 'typing has no durable id');
  const afterTyping = await (await h.call(`/api/live/events?since=${encodeURIComponent(typingCursor)}&conversation_id=${one.id}`)).json();
  assert.equal(afterTyping.events.some((e) => e.type === 'conversation.typing'), false, 'typing is never stored or replayed');
  await typing.cancel();

  // An unknown store is a reset gap; the ready frame still names the live cursor.
  const gap = sseReader(await h.call(`/api/live/stream?v=2&conversation_id=${one.id}&since=deadbeef:999`));
  t.after(() => gap.cancel());
  assert.equal((await gap.next((e) => e.event === 'foxfleet.gap')).data.reason, 'reset');
  assert.equal(typeof (await gap.next((e) => e.event === 'foxfleet.ready')).data.cursor, 'string');
  await gap.cancel();
  assert.equal((await h.call(`/api/live/events?since=${encodeURIComponent(before.cursor)}&conversation_id=nope`)).status, 400);

  const legacy = await addBot(t, h, 'legacy');
  const old = await legacy.connect(V11);
  await old.next((x) => x.t === 'hello');
  await send(h, one.id, { text: 'nothing for 1.1' });
  await sleep(100);
  assert.equal(old.texts.filter((x) => x && x.chat_type === 'group').length, 0);
});

test('one notification per room event (not per member), with a per-room mute shared by every client', async (t) => {
  const boot = await bootBot(t), h = boot.h;
  await addBot(t, h, 'reviewer');
  const room = await (await h.call('/api/conversations', { data: { title: 'Notify', member_ids: ['helper', 'reviewer'] } })).json();
  const other = await roomId(h, 'Elsewhere');
  const stream = sseReader(await h.call('/api/notify/stream'));
  t.after(() => stream.cancel());

  const one = await send(h, room.id, { text: 'first' });
  assert.equal(one.status, 202);
  const first = await stream.next((e) => e.event === 'notify' && e.data?.type === 'conversation');
  assert.equal(first.data.conversation_id, room.id);
  assert.equal(first.data.agent, null, 'a room event is not copied once per participating agent');
  await sleep(100);
  let list = await (await h.call('/api/notify/events?since=0')).json();
  assert.equal(list.events.filter((e) => e.type === 'conversation' && e.conversation_id === room.id).length, 1);

  const muted = await h.call('/api/notify/mute', { method: 'PUT', data: { conversation_id: room.id, muted: true } });
  assert.equal(muted.status, 200);
  assert.deepEqual((await muted.json()).rooms.map((r) => r.conversation_id), [room.id]);
  const two = await send(h, room.id, { text: 'second' });
  assert.equal(two.status, 202);
  await sleep(150);
  const pushed = stream.events.filter((e) => e.event === 'notify' && e.data?.type === 'conversation' && e.data.conversation_id === room.id);
  assert.equal(pushed.length, 1, 'the muted room event is logged, not pushed');
  list = await (await h.call('/api/notify/events?since=0')).json();
  const all = list.events.filter((e) => e.type === 'conversation' && e.conversation_id === room.id);
  assert.equal(all.length, 2, 'one event per room message, not one per bot');
  assert.equal(all[1].muted, true);

  // A different room is not muted by this room's setting.
  assert.equal((await send(h, other.id, { text: 'other' })).status, 202);
  const outsider = await stream.next((e) => e.event === 'notify' && e.data?.conversation_id === other.id);
  assert.equal(outsider.data.muted, false);
  assert.equal((await h.call('/api/notify/mute', { method: 'PUT', data: { conversation_id: room.id, muted: false } })).status, 200);
  assert.equal((await send(h, room.id, { text: 'third' })).status, 202);
  const third = await stream.next((e) => e.event === 'notify' && e.data?.conversation_id === room.id && e.data.id > all[1].id);
  assert.equal(third.data.muted, false);

  // Read state travels to the other clients as a durable room event; unread is per device as before.
  const live = sseReader(await h.call(`/api/live/stream?v=2&conversation_id=${room.id}`));
  t.after(() => live.cancel());
  const read = await h.call(`/api/conversations/${room.id}/read`, { data: {} });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).unread_count, 0);
  const readEvent = await live.next((e) => e.event === 'conversation.read');
  assert.equal(readEvent.data.conversation_id, room.id);
  assert.equal(readEvent.data.read_up_to, 3);
});
