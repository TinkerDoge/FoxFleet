import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, addBot, member } from './bot-helpers.js';

const V12 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const V11 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=', 'base64');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() >= end) return value;
    await sleep(20);
  }
};

const mentionOf = (text, agent) => ({
  kind: 'agent', id: `agent:${agent}`,
  offset: text.toLowerCase().indexOf(`@${agent.toLowerCase()}`),
  length: agent.length + 1,
});
const createRoom = async (h, title, memberIds) => {
  const r = await h.call('/api/conversations', { data: { title, member_ids: memberIds } });
  assert.equal(r.status, 201);
  return r.json();
};
const roomSend = async (h, roomId, data) => {
  const r = await h.call(`/api/conversations/${roomId}/messages`, { data });
  assert.equal(r.status, 202);
  return r.json();
};
const attemptOf = (run) => ({ dispatch_id: run.dispatch_id, run_token: run.run_token });
const agentMessages = async (h, roomId, agent) => {
  const page = await (await h.call(`/api/conversations/${roomId}/messages?limit=500`)).json();
  return page.messages.filter((m) => m.sender.kind === 'agent' && m.sender.id === `agent:${agent}`);
};
const roomRecord = async (h, roomId) => JSON.parse(await readFile(path.join(h.dir, 'conversations', `${roomId}.json`), 'utf8'));
const apiAnswer = (h, agent, roomId, requestId, result, token = h.token) => h.call(
  `/api/agents/${agent}/native/sessions/${roomId}/requests/${requestId}`,
  { token, data: { result } },
);
const upload = (h, roomId, bytes, name = 'picture.png') => fetch(h.base + `/api/conversations/${roomId}/media`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Name': name },
  body: bytes,
});
const botDownload = (h, mediaId, token) => fetch(h.base + `/api/bot/media/${mediaId}`, { headers: { Authorization: `Bot ${token}` } });
const roomDownload = (h, roomId, mediaId, token = h.token) => fetch(h.base + `/api/conversations/${roomId}/media/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });

const fakeReply = async (socket, run, text, extra = {}) => {
  const res = await socket.request({
    t: 'message.send', id: `reply-${run.dispatch_id}`, chat_id: run.chat_id, text,
    final: true, ...attemptOf(run), ...extra,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res;
};
const fakeHandoff = async (socket, run, source, target, text, key) => {
  const res = await socket.request({
    t: 'handoff.request', id: `handoff-${run.dispatch_id}-${target}`, chat_id: run.chat_id,
    thread_id: run.thread_id, source_message_id: source, target_agent_id: `agent:${target}`,
    text, idempotency_key: key, ...attemptOf(run),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.result.pending, true);
  return res;
};
const fakeTurn = async (socket, run, source, { handoff, text = 'fake-model answer', extra = {} } = {}) => {
  if (handoff) await fakeHandoff(socket, run, source, handoff.target, handoff.text, handoff.key);
  return fakeReply(socket, run, text, extra);
};
const fakeModel = (run) => `fake-model: ${run.text}`;

test('Release A e2e: one human mention runs one fake-model turn and one visible agent answer', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const room = await createRoom(sumi.h, 'Release A', ['sumi']);
  const socket = await sumi.connect(V12);
  await socket.next((x) => x.t === 'hello');

  const text = '@sumi review the release gates';
  await roomSend(sumi.h, room.id, { text, mentions: [mentionOf(text, 'sumi')] });
  const run = await socket.next((x) => x.t === 'dispatch.run');
  assert.equal(run.chat_id, room.id);
  assert.equal(run.thread_id, 'fcr_' + room.id.slice(3));
  assert.equal(run.actor.kind, 'human');
  assert.equal(run.actor.is_bot, false);
  assert.equal(run.target_agent_id, 'agent:sumi');
  await fakeReply(socket, run, fakeModel(run));

  const answers = await agentMessages(sumi.h, room.id, 'sumi');
  assert.deepEqual(answers.map((m) => m.text), ['fake-model: @sumi review the release gates']);
  assert.equal(answers[0].delivery_state, 'completed');
  assert.equal(answers[0].dispatch_id, run.dispatch_id);
  assert.equal(socket.texts.filter((x) => x && x.t === 'dispatch.run').length, 1);
});

test('Release A e2e: a structured handoff runs B in the same room and never exceeds the 4-dispatch root budget', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const sora = await addBot(t, sumi.h, 'sora');
  const room = await createRoom(sumi.h, 'Handoff chain', ['sumi', 'sora']);
  const s = await sumi.connect(V12);
  const r = await sora.connect(V12);
  await s.next((x) => x.t === 'hello');
  await r.next((x) => x.t === 'hello');

  const text = '@sumi start the chain';
  const sent = await roomSend(sumi.h, room.id, { text, mentions: [mentionOf(text, 'sumi')] });
  const source = sent.message.id;
  const first = await s.next((x) => x.t === 'dispatch.run');
  await fakeTurn(s, first, source, { handoff: { target: 'sora', text: 'sora continue', key: 'h-1' }, text: 'sumi passes it on' });

  const second = await r.next((x) => x.t === 'dispatch.run');
  assert.equal(second.actor.kind, 'agent');
  assert.equal(second.actor.id, 'agent:sumi');
  assert.equal(second.actor.is_bot, true);
  assert.equal(second.chat_id, room.id);
  await fakeTurn(r, second, source, { handoff: { target: 'sumi', text: 'sumi continue', key: 'h-2' }, text: 'sora passes it back' });

  const third = await s.next((x) => x.t === 'dispatch.run' && x.dispatch_id !== first.dispatch_id);
  await fakeTurn(s, third, source, { handoff: { target: 'sora', text: 'sora one more', key: 'h-3' }, text: 'sumi answers again' });

  const fourth = await r.next((x) => x.t === 'dispatch.run' && x.dispatch_id !== second.dispatch_id);
  await fakeTurn(r, fourth, source, { handoff: { target: 'sumi', text: 'over budget', key: 'h-4' }, text: 'sora closes the chain' });
  await sleep(150);
  assert.equal(s.texts.filter((x) => x && x.t === 'dispatch.run').length, 2);
  assert.equal(r.texts.filter((x) => x && x.t === 'dispatch.run').length, 2);

  const record = await waitFor(async () => {
    const current = await roomRecord(sumi.h, room.id);
    const rows = current.dispatches.filter((d) => d.counts_toward_budget !== false);
    return rows.length === 4 && rows.every((d) => d.state === 'completed')
      && current.dispatches.some((d) => d.code === 'handoff_limit') ? current : null;
  });
  assert.ok(record, 'the chain did not settle inside the test window');
  const counted = record.dispatches.filter((d) => d.counts_toward_budget !== false);
  assert.equal(counted.length, 4);
  assert.deepEqual(counted.map((d) => d.state), ['completed', 'completed', 'completed', 'completed']);
  const over = record.dispatches.find((d) => d.code === 'handoff_limit');
  assert.equal(over.state, 'failed');
  assert.equal(over.counts_toward_budget, false);
  assert.ok(record.messages.some((m) => m.system && m.code === 'handoff_limit' && /4 dispatches/.test(m.body)));
  assert.equal(new Set([first, second, third, fourth].map((run) => run.deadline_at)).size, 1);
  assert.equal(first.deadline_at - first.date, 300_000);
});

test('Release A e2e: a handoff after the five-minute root deadline is refused and never reaches the target', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const sora = await addBot(t, sumi.h, 'sora');
  const room = await createRoom(sumi.h, 'Expired chain', ['sumi', 'sora']);
  const s = await sumi.connect(V12);
  const r = await sora.connect(V12);
  await s.next((x) => x.t === 'hello');
  await r.next((x) => x.t === 'hello');

  const text = '@sumi start the clock';
  const sent = await roomSend(sumi.h, room.id, { text, mentions: [mentionOf(text, 'sumi')] });
  const source = sent.message.id;
  const first = await s.next((x) => x.t === 'dispatch.run');
  await fakeTurn(s, first, source, { handoff: { target: 'sora', text: 'sora continue', key: 'h-exp-1' }, text: 'sumi starts' });
  const child = await r.next((x) => x.t === 'dispatch.run');
  assert.equal(child.deadline_at, first.deadline_at);

  const realNow = Date.now;
  Date.now = () => realNow() + 300_001;
  try {
    await fakeHandoff(r, child, source, 'sumi', 'too late', 'h-exp-2');
    const final = await r.request({
      t: 'message.send', id: 'late-handoff-final', chat_id: room.id, text: 'sora cannot continue',
      final: true, ...attemptOf(child),
    });
    assert.equal(final.ok, false, JSON.stringify(final));
    assert.equal(final.error.code, 'handoff_expired');
  } finally {
    Date.now = realNow;
  }
  await sleep(200);
  assert.equal(s.texts.filter((x) => x && x.t === 'dispatch.run').length, 1);
  const record = await roomRecord(sumi.h, room.id);
  assert.equal(record.dispatches.filter((d) => d.counts_toward_budget !== false).length, 2);
  assert.equal(record.messages.some((m) => m.text === 'sora cannot continue'), false);
});

test('Release A e2e: unaddressed text, quoted mentions and code-block mentions run nobody', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const room = await createRoom(sumi.h, 'Passive room', ['sumi']);
  const socket = await sumi.connect(V12);
  await socket.next((x) => x.t === 'hello');

  for (const text of [
    'just talking to the room',
    '> @sumi this was quoted from an earlier message',
    '```\n@sumi inside a code block\n```',
  ]) await roomSend(sumi.h, room.id, { text });
  await sleep(150);

  assert.equal(socket.texts.filter((x) => x && (x.t === 'dispatch.offer' || x.t === 'dispatch.run' || x.t === 'message.new')).length, 0);
  const page = await (await sumi.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.equal(page.messages.length, 3);
  assert.equal(page.messages.some((m) => m.sender.kind === 'agent'), false);
});

test('Release A e2e: a duplicate human client_id does not double-run the room turn', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const room = await createRoom(sumi.h, 'Idempotent send', ['sumi']);
  const socket = await sumi.connect(V12);
  await socket.next((x) => x.t === 'hello');

  const text = '@sumi exactly once';
  const data = { text, mentions: [mentionOf(text, 'sumi')], client_id: 'release-a-duplicate' };
  const first = await roomSend(sumi.h, room.id, data);
  const run = await socket.next((x) => x.t === 'dispatch.run');
  const second = await roomSend(sumi.h, room.id, data);
  assert.equal(second.message.id, first.message.id);
  await sleep(100);
  assert.equal(socket.texts.filter((x) => x && x.t === 'dispatch.run').length, 1);
  assert.equal(socket.texts.filter((x) => x && x.t === 'dispatch.offer').length, 1);

  await fakeReply(socket, run, 'one answer');
  assert.deepEqual((await agentMessages(sumi.h, room.id, 'sumi')).map((m) => m.text), ['one answer']);
  const page = await (await sumi.h.call(`/api/conversations/${room.id}/messages?limit=500`)).json();
  assert.equal(page.messages.filter((m) => m.client_id === data.client_id || (m.sender.kind === 'human' && m.text === text)).length, 1);
});

test('Release A e2e: Stop cancels queued work, leaves a live turn uncertain, fences late output, and resume never revives it', async (t) => {
  const sumi = await bootBot(t, { botOptions: { stopMs: 150 } }, { name: 'sumi' });
  const sora = await addBot(t, sumi.h, 'sora');
  const room = await createRoom(sumi.h, 'Stop release', ['sumi', 'sora']);
  const s = await sumi.connect(V12);
  const r = await sora.connect(V12);
  await s.next((x) => x.t === 'hello');
  await r.next((x) => x.t === 'hello');

  const firstText = '@sumi long task';
  await roomSend(sumi.h, room.id, { text: firstText, mentions: [mentionOf(firstText, 'sumi')] });
  const live = await s.next((x) => x.t === 'dispatch.run');
  const partial = await s.request({
    t: 'message.send', id: 'stop-partial', chat_id: room.id, text: 'still working', final: false, ...attemptOf(live),
  });
  assert.equal(partial.ok, true, JSON.stringify(partial));

  const queuedText = '@sora queued task';
  await roomSend(sumi.h, room.id, { text: queuedText, mentions: [mentionOf(queuedText, 'sora')] });
  await sleep(100);
  assert.equal(r.texts.filter((x) => x && x.t === 'dispatch.run').length, 0);

  const stopping = sumi.h.call(`/api/conversations/${room.id}/stop`, { method: 'POST', data: {} });
  const stopFrame = await s.next((x) => x.t === 'chat.stop' && x.chat_id === room.id);
  assert.equal(stopFrame.chat_type, 'group');
  assert.equal(stopFrame.actor.kind, 'human');
  assert.equal(stopFrame.actor.is_bot, false);
  const stopped = await stopping;
  assert.equal(stopped.status, 200);
  const body = await stopped.json();
  assert.equal(body.confirmed, false);
  assert.equal(body.paused, true);
  assert.equal(body.cancelled_queued, 1);
  assert.equal(body.agents['agent:sumi'], 'timeout');

  const lateSend = await s.request({
    t: 'message.send', id: 'late-stop-send', chat_id: room.id, text: 'late completion', final: true, ...attemptOf(live),
  });
  assert.equal(lateSend.ok, false, JSON.stringify(lateSend));
  assert.equal(lateSend.error.code, 'dispatch_stale');
  const lateHandoff = await s.request({
    t: 'handoff.request', id: 'late-stop-handoff', chat_id: room.id, thread_id: live.thread_id,
    source_message_id: live.message_id, target_agent_id: 'agent:sora', text: 'late handoff', ...attemptOf(live),
  });
  assert.equal(lateHandoff.ok, false, JSON.stringify(lateHandoff));
  assert.equal(lateHandoff.error.code, 'dispatch_stale');

  const afterStop = await (await sumi.h.call(`/api/conversations/${room.id}/messages?limit=500`)).json();
  assert.equal(afterStop.messages.find((m) => m.id === partial.result.message_id).delivery_state, 'interrupted');
  assert.equal(afterStop.messages.some((m) => m.text === 'late completion'), false);

  const resumed = await sumi.h.call(`/api/conversations/${room.id}/resume`, { method: 'POST', data: {} });
  assert.equal(resumed.status, 200);
  await sleep(200);
  assert.equal(r.texts.filter((x) => x && x.t === 'dispatch.run').length, 0, 'resume never revives the cancelled root');
  assert.equal(s.texts.filter((x) => x && x.t === 'dispatch.run').length, 1);

  const freshText = '@sora fresh task';
  await roomSend(sumi.h, room.id, { text: freshText, mentions: [mentionOf(freshText, 'sora')] });
  const fresh = await r.next((x) => x.t === 'dispatch.run');
  await fakeReply(r, fresh, 'fresh answer');
  const soraAnswers = await agentMessages(sumi.h, room.id, 'sora');
  assert.deepEqual(soraAnswers.map((m) => m.text), ['fresh answer']);
});

test('Release A e2e: another account and a non-member bot cannot read, download, reply, approve or stop', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const outsider = await addBot(t, sumi.h, 'outsider');
  const alice = await member(sumi.h, 'alice');
  const room = await createRoom(sumi.h, 'Private release', ['sumi']);
  const socket = await sumi.connect(V12);
  const intruder = await outsider.connect(V12);
  await socket.next((x) => x.t === 'hello');
  await intruder.next((x) => x.t === 'hello');

  const uploaded = await upload(sumi.h, room.id, PNG);
  assert.equal(uploaded.status, 201);
  const media = await uploaded.json();
  const text = '@sumi inspect this';
  await roomSend(sumi.h, room.id, { text, mentions: [mentionOf(text, 'sumi')], media: [media.id] });
  const run = await socket.next((x) => x.t === 'dispatch.run');
  const card = await socket.request({
    t: 'card.send', id: 'private-card', chat_id: room.id, kind: 'approval', instance: 'private',
    command: 'deploy', actor_kind: 'agent',
  });
  assert.equal(card.ok, true, JSON.stringify(card));
  const requestId = card.result.request_id;

  for (const [method, route] of [
    ['GET', `/api/conversations/${room.id}`],
    ['GET', `/api/conversations/${room.id}/messages`],
    ['POST', `/api/conversations/${room.id}/messages`],
    ['GET', `/api/conversations/${room.id}/media/${media.id}`],
    ['POST', `/api/conversations/${room.id}/stop`],
  ]) {
    const res = await sumi.h.call(route, { token: alice.token, method, ...(method === 'POST' ? { data: { text: 'intrude' } } : {}) });
    assert.equal(res.status, 404, `${method} ${route}`);
  }
  const aliceApproval = await apiAnswer(sumi.h, 'sumi', room.id, requestId, { choice: 'once' }, alice.token);
  assert.ok([403, 404].includes(aliceApproval.status), `other-account card answer: ${aliceApproval.status}`);

  await sleep(100);
  assert.equal(intruder.texts.filter((x) => x && x.chat_type === 'group').length, 0);
  const reply = await intruder.request({
    t: 'message.send', id: 'intruder-reply', chat_id: room.id, text: 'not a member', final: true,
    ...attemptOf(run),
  });
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.equal(reply.error.code, 'forbidden');
  assert.equal((await botDownload(sumi.h, media.id, outsider.token)).status, 404);
  assert.equal((await apiAnswer(sumi.h, 'outsider', room.id, requestId, { choice: 'once' })).status, 404);
  const outsiderStop = await fetch(sumi.h.base + `/api/conversations/${room.id}/stop`, {
    method: 'POST', headers: { Authorization: `Bot ${outsider.token}` },
  });
  assert.equal(outsiderStop.status, 401);

  const queue = await (await sumi.h.call('/api/agents/sumi/queue?session_id=' + room.id)).json();
  assert.deepEqual(queue.open_requests.map((row) => row.request_id), [requestId]);
  assert.equal((await apiAnswer(sumi.h, 'sumi', room.id, requestId, { choice: 'deny' })).status, 200);
  await socket.next((x) => x.t === 'callback' && x.request_id === requestId);
});

test('Release A e2e: an agent cannot answer owner cards or issue an HTTP Stop', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const room = await createRoom(sumi.h, 'Agent authority', ['sumi']);
  const socket = await sumi.connect(V12);
  await socket.next((x) => x.t === 'hello');

  const text = '@sumi ask for approval';
  await roomSend(sumi.h, room.id, { text, mentions: [mentionOf(text, 'sumi')] });
  const run = await socket.next((x) => x.t === 'dispatch.run');
  const card = await socket.request({
    t: 'card.send', id: 'authority-card', chat_id: room.id, kind: 'approval', instance: 'authority',
    command: 'rm -rf build', actor_kind: 'agent',
  });
  assert.equal(card.ok, true, JSON.stringify(card));
  const requestId = card.result.request_id;

  const claim = await socket.request({
    t: 'message.send', id: 'agent-claims-approved', chat_id: room.id, text: 'approved',
    final: false, ...attemptOf(run),
  });
  assert.equal(claim.ok, true, 'an agent may write room text');
  const guessed = await socket.request({
    t: 'callback.answer', id: 'agent-guesses-card', callback_id: 'fcb_' + 'A'.repeat(16),
    chat_id: room.id, thread_id: run.thread_id, outcome: 'resolved',
  });
  assert.equal(guessed.ok, false);
  assert.equal(guessed.error.code, 'not_found');
  assert.equal(socket.texts.filter((x) => x && x.t === 'callback').length, 0);

  const conversationStop = await fetch(sumi.h.base + `/api/conversations/${room.id}/stop`, {
    method: 'POST', headers: { Authorization: `Bot ${sumi.token}` },
  });
  assert.equal(conversationStop.status, 401);
  const rpcStop = await fetch(sumi.h.base + '/api/bot/rpc', {
    method: 'POST',
    headers: { Authorization: `Bot ${sumi.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: 'chat.stop', id: 'rpc-stop', chat_id: room.id, thread_id: run.thread_id }),
  });
  assert.equal(rpcStop.status, 200);
  const rpcBody = await rpcStop.json();
  assert.equal(rpcBody.ok, false);
  assert.ok(['unsupported', 'unknown_type'].includes(rpcBody.error.code), rpcBody.error.code);
  assert.equal((await (await sumi.h.call(`/api/conversations/${room.id}`)).json()).paused, false);

  const queue = await (await sumi.h.call('/api/agents/sumi/queue?session_id=' + room.id)).json();
  assert.deepEqual(queue.open_requests.map((row) => row.request_id), [requestId]);
  assert.equal((await apiAnswer(sumi.h, 'sumi', room.id, requestId, { choice: 'once' })).status, 200);
  const callback = await socket.next((x) => x.t === 'callback' && x.request_id === requestId);
  assert.equal(callback.chat_type, 'group');
  assert.equal(callback.actor.kind, 'human');
  const ack = await socket.request({
    t: 'callback.answer', id: 'owner-tap-ack', callback_id: callback.callback_id,
    chat_id: room.id, thread_id: callback.thread_id, outcome: 'resolved',
  });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  await fakeReply(socket, run, 'owner answered');
});

test('Release A e2e: room media serves identical bytes to members, refuses outsiders, and dies on revoke', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const sora = await addBot(t, sumi.h, 'sora');
  const outsider = await addBot(t, sumi.h, 'outsider');
  const alice = await member(sumi.h, 'alice');
  const room = await createRoom(sumi.h, 'Media release', ['sumi', 'sora']);
  const s = await sumi.connect(V12);
  await s.next((x) => x.t === 'hello');

  const uploaded = await upload(sumi.h, room.id, PNG);
  assert.equal(uploaded.status, 201);
  const media = await uploaded.json();
  const text = '@sumi release image';
  const sent = await roomSend(sumi.h, room.id, { text, mentions: [mentionOf(text, 'sumi')], media: [media.id] });
  assert.deepEqual(sent.message.media.map((row) => row.id), [media.id]);
  await s.next((x) => x.t === 'dispatch.run');

  const owner = await roomDownload(sumi.h, room.id, media.id);
  assert.equal(owner.status, 200);
  const ownerBytes = Buffer.from(await owner.arrayBuffer());
  assert.deepEqual(ownerBytes, PNG);
  for (const token of [sumi.token, sora.token]) {
    const res = await botDownload(sumi.h, media.id, token);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  }
  assert.equal((await botDownload(sumi.h, media.id, outsider.token)).status, 404);
  assert.equal((await roomDownload(sumi.h, room.id, media.id, alice.token)).status, 404);

  const revoked = await sumi.h.call(`/api/conversations/${room.id}/media/${media.id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await roomDownload(sumi.h, room.id, media.id)).status, 404);
  assert.equal((await botDownload(sumi.h, media.id, sumi.token)).status, 404);
  assert.equal((await botDownload(sumi.h, media.id, sora.token)).status, 404);
});

test('Release A e2e: a 1.1 socket never receives a group frame', async (t) => {
  const sumi = await bootBot(t, {}, { name: 'sumi' });
  const sora = await addBot(t, sumi.h, 'sora');
  const legacy = await addBot(t, sumi.h, 'legacy');
  const room = await createRoom(sumi.h, 'Legacy isolation', ['sumi', 'legacy']);
  const s = await sumi.connect(V12);
  const old = await legacy.connect(V11);
  await s.next((x) => x.t === 'hello');
  const oldHello = await old.next((x) => x.t === 'hello');
  assert.ok(!(oldHello.features ?? []).includes('groups'));

  const text = '@sumi modern only';
  await roomSend(sumi.h, room.id, { text, mentions: [mentionOf(text, 'sumi')] });
  const run = await s.next((x) => x.t === 'dispatch.run');

  const joined = await (await sumi.h.call(`/api/conversations/${room.id}/members/sora`, { method: 'PUT' })).json();
  assert.ok(joined.members.some((member) => member.id === 'agent:sora'));
  await s.next((x) => x.t === 'chat.member' && x.action === 'join' && x.member.id === 'agent:sora');
  await sumi.h.call(`/api/conversations/${room.id}/members/sora`, { method: 'DELETE' });
  await s.next((x) => x.t === 'chat.member' && x.action === 'leave' && x.member.id === 'agent:sora');

  const card = await s.request({
    t: 'card.send', id: 'legacy-card', chat_id: room.id, kind: 'approval', instance: 'legacy',
    command: 'deploy', actor_kind: 'agent',
  });
  assert.equal((await apiAnswer(sumi.h, 'sumi', room.id, card.result.request_id, { choice: 'once' })).status, 200);
  await s.next((x) => x.t === 'callback' && x.request_id === card.result.request_id);

  const stopping = sumi.h.call(`/api/conversations/${room.id}/stop`, { method: 'POST', data: {} });
  const stopFrame = await s.next((x) => x.t === 'chat.stop' && x.chat_id === room.id);
  assert.equal((await s.request({
    t: 'callback.answer', id: 'legacy-stop-ack', callback_id: stopFrame.stop_id,
    chat_id: room.id, thread_id: stopFrame.thread_id, outcome: 'stopped',
  })).ok, true);
  assert.equal((await stopping).status, 200);
  await sleep(150);
  assert.equal(old.texts.filter((x) => x && (x.chat_type === 'group' || ['dispatch.offer', 'dispatch.run', 'chat.member', 'chat.stop', 'callback'].includes(x.t))).length, 0);
  assert.equal(run.chat_id, room.id);
});
