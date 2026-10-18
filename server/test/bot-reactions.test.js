// 0.4.2: reactions for bot agents — the REACT: line of a bot reply, and the user's own reactions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootBot } from './bot-helpers.js';

const user = (text) => ({ messages: [{ role: 'user', content: text }] });
const rpc = (b, frame) => b.h.call('/api/bot/rpc', { data: frame, headers: { Authorization: `Bot ${b.token}` } });
const chat = async (b, text = 'hello there') => (await (await b.h.call(`/api/agents/${b.name}/messages`, { data: user(text) })).json()).session_id;
const transcript = async (b, id) => (await (await b.h.call(`/api/agents/${b.name}/sessions/${id}/messages`)).json()).messages;
const snapshot = async (b, id, method = 'GET', data) => (await b.h.call(`/api/agents/${b.name}/sessions/${id}/reactions`, method === 'GET' ? {} : { method, data })).json();

test('a bot reply\'s REACT: line is stripped, stored as a reaction on the newest user message and announced', async (t) => {
  const b = await bootBot(t), id = await chat(b, 'can you react');
  const res = await rpc(b, { t: 'message.send', id: 'r1', chat_id: id, text: 'REACT: 🖤\nHey Doge. Sumi online.', final: true });
  assert.equal(res.status, 200); assert.equal((await res.json()).ok, true);
  const msgs = await transcript(b, id);
  assert.deepEqual(msgs.map((m) => m.content), ['can you react', 'Hey Doge. Sumi online.'], 'the REACT: line is not stored as text');
  const snap = await snapshot(b, id);
  const target = msgs[0].id; // the newest user message
  const mine = snap.messages[target] ?? snap.by_hub_id?.[target];
  assert.ok(mine?.some((g) => g.emoji === '🖤' && g.actors.some((a) => a.kind === 'agent')), 'the emoji lands on the user message as an agent reaction');
  assert.deepEqual(snap.by_hub_id?.[target], mine, 'a bot message id is both ids, so the snapshot mirrors it');
});

test('a reply that is only a REACT: line keeps the emoji as its text and still reacts', async (t) => {
  const b = await bootBot(t), id = await chat(b, 'just react');
  const res = await rpc(b, { t: 'message.send', id: 'r2', chat_id: id, text: 'REACT: 👀', final: true });
  assert.equal((await res.json()).ok, true);
  const msgs = await transcript(b, id);
  assert.equal(msgs.at(-1).content, '👀', 'the run still ends on a real message');
  const snap = await snapshot(b, id);
  assert.ok((snap.messages[msgs[0].id] ?? snap.by_hub_id?.[msgs[0].id])?.some((g) => g.emoji === '👀'));
});

test('the user can react to bot messages: PUT adds, DELETE removes, errors match the shared contract', async (t) => {
  const b = await bootBot(t), id = await chat(b);
  await rpc(b, { t: 'message.send', id: 's1', chat_id: id, text: 'bot reply', final: true });
  const msgs = await transcript(b, id), reply = msgs.at(-1).id;
  const put = await snapshot(b, id, 'PUT', { message_id: reply, emoji: '🎉' });
  assert.equal(put.changed, true);
  assert.ok(put.by_hub_id?.[reply]?.some((g) => g.emoji === '🎉' && g.actors.some((a) => a.kind === 'human')));
  const again = await snapshot(b, id, 'PUT', { message_id: reply, emoji: '🎉' });
  assert.equal(again.changed, false, 'idempotent');
  const del = await snapshot(b, id, 'DELETE', { message_id: reply, emoji: '🎉' });
  assert.equal(del.changed, true); assert.deepEqual(del.by_hub_id?.[reply] ?? [], []);
  const unknown = await b.h.call(`/api/agents/${b.name}/sessions/${id}/reactions`, { method: 'PUT', data: { message_id: 'fm_unknown0000000X', emoji: '🎉' } });
  assert.equal(unknown.status, 404); assert.equal((await unknown.json()).code, 'message_not_found');
  const badEmoji = await b.h.call(`/api/agents/${b.name}/sessions/${id}/reactions`, { method: 'PUT', data: { message_id: reply, emoji: 'yes' } });
  assert.equal(badEmoji.status, 400); assert.equal((await badEmoji.json()).code, 'invalid_emoji');
});

test('delete-for-me hides a bot message from the transcript until it is restored', async (t) => {
  const b = await bootBot(t), id = await chat(b, 'hide me not');
  await rpc(b, { t: 'message.send', id: 'h1', chat_id: id, text: 'first reply', final: true });
  await rpc(b, { t: 'message.send', id: 'h2', chat_id: id, text: 'second reply', final: true });
  const msgs = await transcript(b, id), victim = msgs.at(-1).id;
  const hide = await b.h.call(`/api/agents/${b.name}/sessions/${id}/hidden`, { method: 'PUT', data: { message_id: victim } });
  assert.equal(hide.status, 200);
  assert.deepEqual((await transcript(b, id)).map((m) => m.content), ['hide me not', 'first reply']);
  const snap = await snapshot(b, id);
  assert.ok(snap.hidden.includes(victim) && snap.hidden_hub_ids.includes(victim));
  await b.h.call(`/api/agents/${b.name}/sessions/${id}/hidden`, { method: 'DELETE', data: { message_id: victim } });
  assert.equal((await transcript(b, id)).length, 3, 'restored');
});

test('bot agents advertise reaction capabilities so the apps show the affordances', async (t) => {
  const b = await bootBot(t);
  const probe = await (await b.h.call('/api/agents/helper')).json();
  assert.equal(probe.agent.capabilities.reactions, true);
  assert.equal(probe.agent.capabilities.agentReactions, true);
});

test('old stored replies that still contain a REACT: line derive their reaction on read', async (t) => {
  const b = await bootBot(t), id = await chat(b, 'from before the strip');
  // a non-final interim frame keeps its raw text (nothing else has streamed yet), emulating a
  // reply stored before 0.4.2
  await rpc(b, { t: 'message.send', id: 'o1', chat_id: id, text: 'REACT: 🖤' });
  const msgs = await transcript(b, id);
  assert.equal(msgs.at(-1).content, 'REACT: 🖤', 'a REACT:-only interim frame is kept verbatim');
  const snap = await snapshot(b, id);
  assert.ok((snap.messages[msgs[0].id] ?? snap.by_hub_id?.[msgs[0].id])?.some((g) => g.emoji === '🖤'), 'derived on read');
});
