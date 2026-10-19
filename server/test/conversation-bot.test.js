// foxfleet.bot/1.2 room transport over the bot socket: negotiation, admission, dispatch, handoff, receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bootBot, addBot } from './bot-helpers.js';
import { validateRoomFrame, validateRequest, selectSubprotocol, SUBPROTOCOL_V12, SUBPROTOCOL_V11, SUBPROTOCOL } from '../bot-protocol.js';

const root = new URL('../../contract/', import.meta.url);
const vectors = JSON.parse(await readFile(new URL('bot-frames.vectors.json', root), 'utf8')).rooms;
const V12_HEADERS = { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1' };
const V11_HEADERS = { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1, foxfleet.bot.v1' };
const mentionOf = (text, id = 'agent:helper') => {
  const at = text.indexOf('@' + id.slice(6));
  return { kind: 'agent', id, offset: at, length: 1 + id.slice(6).length };
};
const roomSend = async (h, id, text, mentions) => {
  const r = await h.call(`/api/conversations/${id}/messages`, {
    data: { text, mentions: mentions ?? (text.includes('@') ? [mentionOf(text)] : undefined) },
  });
  assert.equal(r.status, 202);
  return r.json();
};
const createRoom = async (h, title, member_ids) => {
  const r = await h.call('/api/conversations', { data: { title, member_ids } });
  assert.equal(r.status, 201);
  return r.json();
};

test('negotiation: v1.2 is preferred but every older offer still selects its own version', () => {
  assert.equal(selectSubprotocol('foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1'), SUBPROTOCOL_V12);
  assert.equal(selectSubprotocol('foxfleet.bot.v1.1, foxfleet.bot.v1'), SUBPROTOCOL_V11);
  assert.equal(selectSubprotocol('foxfleet.bot.v1'), SUBPROTOCOL);
  assert.equal(selectSubprotocol(''), null);
});

test('frozen room vectors: the production validator accepts and refuses exactly the shared fixtures', () => {
  for (const { name, frame, context } of vectors.valid) {
    const verdict = validateRoomFrame(frame, context ?? {});
    assert.equal(verdict.ok, true, `${name}: ${verdict.code ?? ''} ${verdict.message ?? ''}`);
  }
  for (const { name, frame, code, context } of vectors.invalid) {
    const verdict = validateRoomFrame(frame, context ?? {});
    assert.equal(verdict.ok, false, `${name} was accepted`);
    assert.equal(verdict.code, code, `${name}: ${verdict.message}`);
  }
  // Legacy 1.0/1.1 requests keep refusing the room control frames.
  const sample = { chat_id: 'fc_AAAAAAAAAAAAAAAA', thread_id: 'fcr_BBBBBBBBBBBBBBBB', dispatch_id: 'fd_CCCCCCCCCCCCCCCC', target_agent_id: 'agent:helper' };
  for (const t of ['chat.member', 'chat.get', 'chat.cancel']) {
    assert.deepEqual(validateRequest({ t, id: 'r1', ...sample }).code, 'unsupported', t);
  }
  assert.deepEqual(validateRequest({ t: 'handoff.request', id: 'r1', ...sample }).code, 'unknown_type');
});

test('a 1.2 socket negotiates groups; a later 1.1 socket on the same account never gets them', async (t) => {
  const boot = await bootBot(t);
  const v12 = await boot.connect({ headers: V12_HEADERS });
  const hello = await v12.next((x) => x.t === 'hello');
  assert.equal(v12.headers['sec-websocket-protocol'], 'foxfleet.bot.v1.2');
  assert.equal(hello.protocol, 'foxfleet.bot/1.2');
  assert.deepEqual(hello.features, ['stop', 'cards', 'media', 'groups']);
  assert.equal(hello.limits.max_mentions, 64);
  assert.equal(hello.limits.max_handoff_dispatches_per_root, 4);

  const v11 = await boot.connect({ headers: V11_HEADERS });
  const old = await v11.next((x) => x.t === 'hello');
  assert.equal(v11.headers['sec-websocket-protocol'], 'foxfleet.bot.v1.1');
  assert.equal(old.protocol, 'foxfleet.bot/1.1');
  assert.ok(!(old.features ?? []).includes('groups'));
});

test('actual gateway admission: a human room request reaches the dispatch-bound bot and a final is committed', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Review', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');

  const text = '@helper review the patch';
  await roomSend(boot.h, room.id, text);
  const event = await c.next((x) => x.t === 'message.new' && x.chat_type === 'group');
  assert.equal(event.chat_id, room.id);
  assert.equal(event.thread_id, 'fcr_' + room.id.slice(3));
  assert.equal(event.actor.kind, 'human');
  assert.equal(event.actor.is_bot, false);
  const offer = await c.next((x) => x.t === 'dispatch.offer');
  const run = await c.next((x) => x.t === 'dispatch.run');
  assert.equal(offer.dispatch_id, run.dispatch_id);
  assert.equal(run.chat_id, room.id);
  assert.equal(run.thread_id, 'fcr_' + room.id.slice(3));
  assert.equal(run.run_token.length > 0, true);
  assert.equal(run.actor.kind, 'human');

  const res = await c.request({ t: 'message.send', id: 'r-final', chat_id: room.id, text: 'Looks good.', final: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.result.message_id, /^fm_/);
  await c.next((x) => x.t === 'res' && x.id === 'r-final');
  const messages = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.ok(messages.messages.some((m) => m.sender.id === 'agent:helper' && m.text === 'Looks good.'));
});

test('handoff is a callable hub request and the child turn is agent-origin, never the owner', async (t) => {
  const boot = await bootBot(t);
  const reviewer = await addBot(t, boot.h, 'reviewer');
  const room = await createRoom(boot.h, 'Handoff', ['helper', 'reviewer']);
  const c = await boot.connect({ headers: V12_HEADERS });
  const rv = await reviewer.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello'); await rv.next((x) => x.t === 'hello');

  const text = '@helper start the review';
  const sent = await roomSend(boot.h, room.id, text);
  const run = await c.next((x) => x.t === 'dispatch.run');
  const handoff = await c.request({
    t: 'handoff.request', id: 'h1', chat_id: room.id, thread_id: run.thread_id,
    source_message_id: sent.message.id, target_agent_id: 'agent:reviewer', text: 'Please verify the numbers.',
  });
  assert.equal(handoff.ok, true, JSON.stringify(handoff));
  assert.equal(handoff.result.pending, true);

  const final = await c.request({ t: 'message.send', id: 'r-final', chat_id: room.id, text: 'Handing this over.', final: true });
  assert.equal(final.ok, true, JSON.stringify(final));
  const child = await rv.next((x) => x.t === 'dispatch.run');
  assert.equal(child.actor.kind, 'agent');
  assert.equal(child.actor.id, 'agent:helper');
  assert.equal(child.actor.is_bot, true);
  assert.equal(child.text, 'Please verify the numbers.');

  const childFinal = await rv.request({ t: 'message.send', id: 'rv-final', chat_id: room.id, text: 'Numbers check out.', final: true });
  assert.equal(childFinal.ok, true, JSON.stringify(childFinal));
  const messages = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.ok(messages.messages.some((m) => m.sender.id === 'agent:reviewer' && m.text === 'Numbers check out.'));
});

test('a reconnect re-delivers the same running receipt; DMs and another room stay separate', async (t) => {
  const boot = await bootBot(t);
  const other = await createRoom(boot.h, 'Other room', ['helper']);
  const room = await createRoom(boot.h, 'Main room', ['helper']);
  let c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await roomSend(boot.h, room.id, '@helper hold this turn');
  const first = await c.next((x) => x.t === 'dispatch.run');

  c.end();
  c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  const replay = await c.next((x) => x.t === 'dispatch.run');
  assert.equal(replay.dispatch_id, first.dispatch_id);
  assert.equal(replay.run_token, first.run_token);
  assert.equal(replay.chat_id, room.id);

  // A DM to the same bot is its own message stream and is not a group frame.
  const dm = await boot.h.call('/api/agents/helper/messages', { data: { messages: [{ role: 'user', content: 'direct hello' }] } });
  assert.equal(dm.status, 202);
  const dmFrame = await c.next((x) => x.t === 'message.new' && x.chat_type === 'dm');
  assert.equal(dmFrame.chat_type, 'dm');
  assert.ok(!('thread_id' in dmFrame));

  // The other room exists and has a different fcr_ session identity; it emits no frames for this turn.
  assert.notEqual('fcr_' + other.id.slice(3), first.thread_id);
  assert.equal((await c.texts.filter((x) => x.t === 'dispatch.run' && x.chat_id === other.id)).length, 0);
});
