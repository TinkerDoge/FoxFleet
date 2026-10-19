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
const attemptOf = (run) => ({ dispatch_id: run.dispatch_id, run_token: run.run_token });

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

  const res = await c.request({ t: 'message.send', id: 'r-final', chat_id: room.id, text: 'Looks good.', final: true, ...attemptOf(run) });
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
    ...attemptOf(run),
  });
  assert.equal(handoff.ok, true, JSON.stringify(handoff));
  assert.equal(handoff.result.pending, true);

  const final = await c.request({ t: 'message.send', id: 'r-final', chat_id: room.id, text: 'Handing this over.', final: true, ...attemptOf(run) });
  assert.equal(final.ok, true, JSON.stringify(final));
  const child = await rv.next((x) => x.t === 'dispatch.run');
  assert.equal(child.actor.kind, 'agent');
  assert.equal(child.actor.id, 'agent:helper');
  assert.equal(child.actor.is_bot, true);
  assert.equal(child.text, 'Please verify the numbers.');

  const childFinal = await rv.request({ t: 'message.send', id: 'rv-final', chat_id: room.id, text: 'Numbers check out.', final: true, ...attemptOf(child) });
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

test('a live room turn only accepts its exact attempt; missing, mismatched and foreign tokens fail closed', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Bound', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');

  await roomSend(boot.h, room.id, '@helper hold this turn');
  const run = await c.next((x) => x.t === 'dispatch.run');

  const missing = await c.request({ t: 'message.send', id: 'no-attempt', chat_id: room.id, text: 'no attempt', final: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'dispatch_not_running');

  const wrongToken = await c.request({
    t: 'message.send', id: 'wrong-token', chat_id: room.id, text: 'wrong token', final: true,
    dispatch_id: run.dispatch_id, run_token: 'fr_wrong',
  });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.error.code, 'dispatch_stale');

  const foreignDispatch = await c.request({
    t: 'message.send', id: 'foreign-dispatch', chat_id: room.id, text: 'foreign dispatch', final: true,
    dispatch_id: 'fd_ZZZZZZZZZZZZZZZZ', run_token: run.run_token,
  });
  assert.equal(foreignDispatch.ok, false);
  assert.equal(foreignDispatch.error.code, 'dispatch_not_running');

  const handoff = await c.request({
    t: 'handoff.request', id: 'handoff-no-attempt', chat_id: room.id, thread_id: run.thread_id,
    source_message_id: run.message_id, target_agent_id: 'agent:helper', text: 'no attempt',
  });
  assert.equal(handoff.ok, false);
  assert.equal(handoff.error.code, 'dispatch_not_running');

  const edit = await c.request({ t: 'message.edit', id: 'edit-no-attempt', chat_id: room.id, message_id: run.message_id, text: 'no attempt', final: true });
  assert.equal(edit.ok, false);
  assert.equal(edit.error.code, 'dispatch_not_running');

  const final = await c.request({ t: 'message.send', id: 'bound-final', chat_id: room.id, text: 'bound final', final: true, ...attemptOf(run) });
  assert.equal(final.ok, true, JSON.stringify(final));
});

test('a timed-out attempt cannot finalize or hand off the next attempt for the same room', async (t) => {
  const boot = await bootBot(t);
  const reviewer = await addBot(t, boot.h, 'reviewer');
  const room = await createRoom(boot.h, 'Retry', ['helper', 'reviewer']);
  const c = await boot.connect({ headers: V12_HEADERS });
  const rv = await reviewer.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');
  await rv.next((x) => x.t === 'hello');

  // The engine races every run against the five-minute root deadline. Compress only that long timer so this
  // test can observe a real uncertain attempt, then restore the clock before the retry starts.
  const realSetTimeout = global.setTimeout;
  const fastDeadline = (fn, ms, ...args) => realSetTimeout(fn, ms >= 250_000 ? 30 : ms, ...args);
  global.setTimeout = fastDeadline;
  t.after(() => { if (global.setTimeout === fastDeadline) global.setTimeout = realSetTimeout; });

  await roomSend(boot.h, room.id, '@helper first attempt');
  const old = await c.next((x) => x.t === 'dispatch.run');
  await new Promise((resolve) => realSetTimeout(resolve, 150));
  global.setTimeout = realSetTimeout;

  await roomSend(boot.h, room.id, '@helper second attempt');
  const fresh = await c.next((x) => x.t === 'dispatch.run' && x.dispatch_id !== old.dispatch_id);
  assert.notEqual(fresh.run_token, old.run_token);

  const staleFinal = await c.request({
    t: 'message.send', id: 'old-final', chat_id: room.id, text: 'old attempt final', final: true, ...attemptOf(old),
  });
  assert.equal(staleFinal.ok, false);
  assert.ok(['dispatch_stale', 'dispatch_not_running'].includes(staleFinal.error.code), JSON.stringify(staleFinal));

  const staleHandoff = await c.request({
    t: 'handoff.request', id: 'old-handoff', chat_id: room.id, thread_id: old.thread_id,
    source_message_id: old.message_id, target_agent_id: 'agent:reviewer', text: 'old attempt handoff', ...attemptOf(old),
  });
  assert.equal(staleHandoff.ok, false);
  assert.ok(['dispatch_stale', 'dispatch_not_running'].includes(staleHandoff.error.code), JSON.stringify(staleHandoff));

  const final = await c.request({
    t: 'message.send', id: 'fresh-final', chat_id: room.id, text: 'fresh attempt final', final: true, ...attemptOf(fresh),
  });
  assert.equal(final.ok, true, JSON.stringify(final));

  const messages = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.ok(messages.messages.some((m) => m.sender.id === 'agent:helper' && m.text === 'fresh attempt final'));
  assert.ok(!messages.messages.some((m) => m.text === 'old attempt final' || m.text === 'old attempt handoff'));
});

test('a 1.2 connect replays every current agent member as a join event', async (t) => {
  const boot = await bootBot(t);
  await addBot(t, boot.h, 'reviewer');
  const room = await createRoom(boot.h, 'Members', ['helper', 'reviewer']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');

  const selfJoin = await c.next((x) => x.t === 'chat.member' && x.chat_id === room.id && x.member.id === 'agent:helper');
  const peerJoin = await c.next((x) => x.t === 'chat.member' && x.chat_id === room.id && x.member.id === 'agent:reviewer');
  for (const frame of [selfJoin, peerJoin]) {
    assert.equal(frame.action, 'join');
    assert.equal(frame.chat_type, 'group');
    assert.equal(frame.thread_id, 'fcr_' + room.id.slice(3));
    assert.equal(frame.actor.kind, 'human');
    assert.equal(frame.actor.is_bot, false);
    assert.equal(frame.member.kind, 'agent');
    assert.equal(frame.member.is_bot, true);
    assert.ok(Number.isInteger(frame.event_id) && frame.event_id >= 1);
  }
});

test('live join and leave reach every 1.2 member and never a 1.1 socket', async (t) => {
  const boot = await bootBot(t);
  const reviewer = await addBot(t, boot.h, 'reviewer');
  const legacy = await addBot(t, boot.h, 'legacy');
  const room = await createRoom(boot.h, 'Live members', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  const rv = await reviewer.connect({ headers: V12_HEADERS });
  const old = await legacy.connect({ headers: V11_HEADERS });
  await c.next((x) => x.t === 'hello');
  await rv.next((x) => x.t === 'hello');
  await old.next((x) => x.t === 'hello');

  const joined = await (await boot.h.call(`/api/conversations/${room.id}/members/agent:reviewer`, { method: 'PUT' })).json();
  assert.ok(joined.members.some((m) => m.id === 'agent:reviewer'));
  const joinForHelper = await c.next((x) => x.t === 'chat.member' && x.action === 'join' && x.member.id === 'agent:reviewer');
  const joinForReviewer = await rv.next((x) => x.t === 'chat.member' && x.action === 'join' && x.member.id === 'agent:reviewer');
  assert.equal(joinForHelper.chat_id, room.id);
  assert.equal(joinForReviewer.member.name, 'reviewer');

  const left = await (await boot.h.call(`/api/conversations/${room.id}/members/agent:reviewer`, { method: 'DELETE' })).json();
  assert.ok(!left.members.some((m) => m.id === 'agent:reviewer'));
  await c.next((x) => x.t === 'chat.member' && x.action === 'leave' && x.member.id === 'agent:reviewer');
  await rv.next((x) => x.t === 'chat.member' && x.action === 'leave' && x.member.id === 'agent:reviewer');

  assert.equal(old.texts.filter((x) => x && x.t === 'chat.member').length, 0);
});

test('a room reply keeps its thinking: the send carries it, an edit updates it, the dispatch frame never does', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Thinking', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');

  await roomSend(boot.h, room.id, '@helper think about it');
  const run = await c.next((x) => x.t === 'dispatch.run');
  // The agent's context carries the request, never its own thinking.
  assert.equal('reasoning' in run, false, 'the dispatch frame has no reasoning');
  assert.equal(run.text, '@helper think about it');
  assert.deepEqual(run.mentions, [{ kind: 'agent', id: 'agent:helper', offset: 0, length: 7 }]);

  const partial = await c.request({ t: 'message.send', id: 'think-1', chat_id: room.id, text: 'draft', final: false, reasoning: 'first thoughts', ...attemptOf(run) });
  assert.equal(partial.ok, true, JSON.stringify(partial));
  const listed = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  const row = listed.messages.find((m) => m.id === partial.result.message_id);
  assert.equal(row.reasoning, 'first thoughts');

  // The plugin flushes the thinking with a non-final edit: the message keeps the newest one.
  const edit = await c.request({ t: 'message.edit', id: 'think-2', chat_id: room.id, message_id: partial.result.message_id, text: 'draft', final: false, reasoning: 'more thoughts', ...attemptOf(run) });
  assert.equal(edit.ok, true, JSON.stringify(edit));
  const after = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  const edited = after.messages.find((m) => m.id === partial.result.message_id);
  assert.equal(edited.reasoning, 'more thoughts');
  assert.equal(edited.edited, true);

  // The final answer keeps the thinking too.
  const final = await c.request({ t: 'message.send', id: 'think-final', chat_id: room.id, text: 'the answer', final: true, reasoning: 'the last thoughts', ...attemptOf(run) });
  assert.equal(final.ok, true, JSON.stringify(final));
  const done = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  const answer = done.messages.find((m) => m.id === final.result.message_id);
  assert.equal(answer.reasoning, 'the last thoughts');
  assert.equal(answer.text, 'the answer');
});

test('a final edit promotes the streamed message and completes the exact attempt', async (t) => {
  const boot = await bootBot(t);
  const room = await createRoom(boot.h, 'Final edit', ['helper']);
  const c = await boot.connect({ headers: V12_HEADERS });
  await c.next((x) => x.t === 'hello');

  await roomSend(boot.h, room.id, '@helper stream this');
  const run = await c.next((x) => x.t === 'dispatch.run');
  const partial = await c.request({ t: 'message.send', id: 'stream-1', chat_id: room.id, text: 'draft', final: false, ...attemptOf(run) });
  assert.equal(partial.ok, true, JSON.stringify(partial));

  const final = await c.request({
    t: 'message.edit', id: 'stream-final', chat_id: room.id, message_id: partial.result.message_id,
    text: 'authoritative final', final: true, ...attemptOf(run),
  });
  assert.equal(final.ok, true, JSON.stringify(final));
  assert.equal(final.result.edited, true);

  const messages = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.ok(messages.messages.some((m) => m.sender.id === 'agent:helper' && m.text === 'authoritative final'));

  await roomSend(boot.h, room.id, '@helper next turn');
  const next = await c.next((x) => x.t === 'dispatch.run' && x.dispatch_id !== run.dispatch_id);
  assert.notEqual(next.run_token, run.run_token);
  await c.request({ t: 'message.send', id: 'next-final', chat_id: room.id, text: 'next answer', final: true, ...attemptOf(next) });
});
