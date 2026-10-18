// 0.4.2: a bot turn's thinking (reasoning) — stored with the reply, served in history, streamed live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootBot, sseReader } from './bot-helpers.js';

const user = (text) => ({ messages: [{ role: 'user', content: text }] });
const rpc = (b, frame) => b.h.call('/api/bot/rpc', { data: frame, headers: { Authorization: `Bot ${b.token}` } });
const chat = async (b, text = 'think this through') => (await (await b.h.call(`/api/agents/${b.name}/messages`, { data: user(text) })).json()).session_id;
const transcript = async (b, id) => (await (await b.h.call(`/api/agents/${b.name}/sessions/${id}/messages`)).json()).messages;
const liveRun = async (b, id) => (await (await b.h.call(`/api/agents/${b.name}/runs?session_id=${id}`)).json()).runs[0];

test("a turn's thinking rides with the reply: streamed as snapshots, kept in history", async (t) => {
  const b = await bootBot(t), id = await chat(b);
  const run = await liveRun(b, id);
  const s = sseReader(await b.h.call(`/api/agents/${b.name}/runs/${run.id}/events`)); t.after(() => s.cancel());
  const sent = await (await rpc(b, { t: 'message.send', id: 'r1', chat_id: id, text: 'Working on it.', reasoning: 'Check the logs. ' })).json();
  const mid = sent.result.message_id;
  // A second snapshot repeats the text and adds more: the app is given the whole text each time.
  assert.equal((await rpc(b, { t: 'message.edit', id: 'r2', chat_id: id, message_id: mid, text: 'Working on it.', reasoning: 'Check the logs. Then the config.' })).status, 200);
  assert.equal((await rpc(b, { t: 'message.edit', id: 'r3', chat_id: id, message_id: mid, text: 'Fixed. The port was wrong.', reasoning: 'Check the logs. Then the config.', final: true })).status, 200);
  await s.until(() => s.events.filter((e) => e.event === 'foxfleet.reasoning').length >= 2, 5000);
  const shown = s.events.filter((e) => e.event === 'foxfleet.reasoning').map((e) => e.data.text);
  assert.deepEqual(shown, ['Check the logs. ', 'Check the logs. Then the config.'], 'each event is the whole thinking so far; an unchanged frame adds nothing');
  const msgs = await transcript(b, id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, 'Fixed. The port was wrong.');
  assert.equal(msgs[1].reasoning, 'Check the logs. Then the config.', 'history carries the thinking');
  assert.equal(msgs[0].reasoning, undefined, 'the user message has none');
});

test('reasoning is optional, bounded and must be a string', async (t) => {
  const b = await bootBot(t), id = await chat(b);
  assert.equal((await rpc(b, { t: 'message.send', id: 'a', chat_id: id, text: 'no thinking' })).status, 200);
  for (const bad of [42, { text: 'x' }, 'x'.repeat(65537)]) {
    const res = await rpc(b, { t: 'message.send', id: 'bad-' + String(bad).length, chat_id: id, text: 'nope', reasoning: bad });
    const body = await res.json();
    assert.equal(body.ok, false, `reasoning ${typeof bad} is refused`);
    assert.equal(body.error.code, 'invalid_request');
  }
});

test('an edit that clears the thinking removes it from history', async (t) => {
  const b = await bootBot(t), id = await chat(b);
  const mid = (await (await rpc(b, { t: 'message.send', id: 'e1', chat_id: id, text: 'answer', reasoning: 'hmm' })).json()).result.message_id;
  assert.equal((await rpc(b, { t: 'message.edit', id: 'e2', chat_id: id, message_id: mid, text: 'answer', reasoning: '', final: true })).status, 200);
  assert.equal((await transcript(b, id))[1].reasoning, undefined);
});
