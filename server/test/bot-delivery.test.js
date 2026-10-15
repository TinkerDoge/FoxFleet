// Durability and delivery: offline queueing, restart replay, ack semantics, window and backlog, and "never any other transport".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, bootHub, sseReader } from './bot-helpers.js';

const send = (b, text, extra = {}) => b.h.call('/api/agents/helper/messages', { data: { messages: [{ role: 'user', content: text }], ...extra } });
const readStore = async (b) => JSON.parse(await readFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), 'utf8'));
const news = (c) => c.texts.filter((x) => x.t === 'message.new');

test('an offline bot: the message is stored (bot.online false); after a hub restart the bot connects and gets hello then the replay', async (t) => {
  const b = await bootBot(t);
  const r = await send(b, 'are you there?'); assert.equal(r.status, 202); const body = await r.json(); assert.deepEqual(body.bot, { online: false });
  await b.h.restart();
  const c = await b.connect(); const hello = await c.next((x) => x.t === 'hello');
  assert.equal(hello.resume_from, 0); assert.equal(hello.latest_event_id, 1);
  const ev = await c.next((x) => x.t === 'message.new');
  assert.deepEqual([ev.event_id, ev.chat_id, ev.message_id, ev.text], [1, body.session_id, body.message.id, 'are you there?']);
  assert.equal(c.texts[0].t, 'hello');
});

test('no other transport: every bot operation leaves a direct agent and the connector hub untouched', async (t) => {
  const seen = []; const upstream = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(500); res.end(); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r)); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const port = upstream.address().port;
  const h = await bootHub(t); let attached = 0; const attach = h.server.connectors.attach; h.server.connectors.attach = (...a) => { attached++; return attach.apply(h.server.connectors, a); };
  assert.equal((await h.call('/api/connections', { data: { name: 'desk', host: '127.0.0.1', dashboardPort: port, apiServerPort: port } })).status, 201);
  assert.equal((await h.call('/api/connections', { data: { kind: 'hermes', connection: 'bot', name: 'helper' } })).status, 201);
  const { token } = await (await h.call('/api/agents/helper/bot-token', { data: {} })).json();
  const { botSocket } = await import('./bot-helpers.js'); const c = await botSocket(t, h.port, token); await c.next((x) => x.t === 'hello');
  const A = '/api/agents/helper';
  const first = await (await h.call(`${A}/messages`, { data: { messages: [{ role: 'user', content: 'hi' }] } })).json();
  const ev = await c.next((x) => x.t === 'message.new');
  const stream = await h.call(`${A}/chat`, { data: { messages: [{ role: 'user', content: 'chat' }], session_id: first.session_id } }); const s = sseReader(stream); t.after(() => s.cancel());
  await c.request({ t: 'message.send', id: 'a', chat_id: ev.chat_id, text: 'reply', final: true }); await s.finished();
  await c.request({ t: 'commands.set', id: 'c', commands: [{ name: 'help', description: 'Help' }] }).catch(() => {});
  for (const route of ['sessions', `sessions/${first.session_id}/messages`, 'runs', 'queue', 'commands', 'native', 'files', 'skills', 'config', 'screen/status', 'cron', 'logs', 'usage', 'artifacts', 'profiles', 'sessions/x/search']) await h.call(`${A}/${route}`);
  await h.call(`${A}/media`, { data: { ref: 'x' } }); await h.call(`${A}/transcribe`, { data: { data_url: 'data:audio/webm;base64,AA==' } });
  assert.equal((await h.call(`${A}`)).status, 200);
  assert.equal((await h.call(`${A}/bot-token`, { method: 'DELETE' })).status, 200);
  assert.equal((await h.call('/api/connections/helper', { method: 'DELETE' })).status, 200);
  assert.deepEqual(seen, [], 'the upstream server received nothing'); assert.equal(attached, 0);
});

async function twoEvents(t, options) {
  const b = await bootBot(t, options), c = await b.connect(); await c.next((x) => x.t === 'hello');
  for (const text of ['one', 'two']) assert.equal((await send(b, text)).status, 202);
  await c.until(() => news(c).length === 2); return { b, c };
}

test('ack beyond what was delivered on this connection is ack_out_of_range and changes nothing', async (t) => {
  const { b, c } = await twoEvents(t); const before = await readFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), 'utf8');
  const res = await c.request({ t: 'ack', id: 'k1', event_id: 3 }); assert.equal(res.ok, false); assert.equal(res.error.code, 'ack_out_of_range');
  c.send({ t: 'ack', event_id: 99 }); const err = await c.next((x) => x.t === 'error'); assert.equal(err.code, 'ack_out_of_range');
  assert.equal(await readFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), 'utf8'), before, 'file untouched');
});

test('ack: negative or non-integer is invalid_request; the cumulative ack is on disk when the res arrives; lower and repeated acks are no-ops', async (t) => {
  const { b, c } = await twoEvents(t);
  for (const event_id of [-1, 1.5, '1']) { const r = await c.request({ t: 'ack', id: `bad${String(event_id)}`, event_id }); assert.equal(r.error.code, 'invalid_request'); }
  assert.equal((await readStore(b)).acked, 0);
  const ok = await c.request({ t: 'ack', id: 'k2', event_id: 2 }); assert.deepEqual(ok, { t: 'res', id: 'k2', ok: true, result: { acked: 2 } });
  const disk = await readStore(b); assert.equal(disk.acked, 2); assert.deepEqual(disk.events, [], 'acknowledged events are dropped');
  const mtime = JSON.stringify(disk);
  assert.deepEqual((await c.request({ t: 'ack', id: 'k3', event_id: 2 })).result, { acked: 2 });
  assert.deepEqual((await c.request({ t: 'ack', id: 'k4', event_id: 1 })).result, { acked: 1 });
  assert.equal(JSON.stringify(await readStore(b)), mtime, 'no-op acks write nothing new');
  assert.deepEqual((await c.request({ t: 'ack', id: 'k5', event_id: 0 })).ok, true);
});

test('after an ack only the unacknowledged events replay, on reconnect and after a hub restart', async (t) => {
  const { b, c } = await twoEvents(t);
  c.send({ t: 'ack', event_id: 1 }); await c.request({ t: 'ping', id: 'sync' }).catch(() => {}); await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readStore(b)).acked, 1);
  const again = await b.connect(); const hello = await again.next((x) => x.t === 'hello'); assert.equal(hello.resume_from, 1); assert.equal(hello.latest_event_id, 2);
  assert.deepEqual((await again.until(() => news(again).length >= 1 && news(again))).map((e) => [e.event_id, e.text]), [[2, 'two']]);
  assert.equal((await c.waitClose()).code, 4009);
  await b.h.restart();
  const third = await b.connect(); assert.equal((await third.next((x) => x.t === 'hello')).resume_from, 1);
  await third.until(() => news(third).length >= 1); assert.deepEqual(news(third).map((e) => e.event_id), [2]);
  assert.equal((await send(b, 'three')).status, 202); await third.until(() => news(third).length === 2); assert.deepEqual(news(third).map((e) => e.event_id), [2, 3], 'ids keep counting after a restart');
});

test('window: only botOptions.window events are outstanding; acks release more', async (t) => {
  const b = await bootBot(t, { botOptions: { window: 2 } });
  for (const text of ['m1', 'm2', 'm3', 'm4', 'm5']) assert.equal((await send(b, text)).status, 202);
  const c = await b.connect(); await c.next((x) => x.t === 'hello');
  await c.until(() => news(c).length === 2); await new Promise((r) => setTimeout(r, 60)); assert.deepEqual(news(c).map((e) => e.event_id), [1, 2], 'two delivered, the rest wait');
  await c.request({ t: 'ack', id: 'a1', event_id: 1 }); await c.until(() => news(c).length === 3); assert.deepEqual(news(c).map((e) => e.event_id), [1, 2, 3]);
  await c.request({ t: 'ack', id: 'a3', event_id: 3 }); await c.until(() => news(c).length === 5); assert.deepEqual(news(c).map((e) => e.event_id), [1, 2, 3, 4, 5]);
  assert.equal((await send(b, 'm6')).status, 202); await new Promise((r) => setTimeout(r, 60)); assert.equal(news(c).length, 5, 'window is full again (4 and 5 unacked)... 6 waits') ;
  await c.request({ t: 'ack', id: 'a5', event_id: 5 }); await c.until(() => news(c).length === 6);
});

test('backlog: with maxUnacked unread events a new user message is refused (503 bot_backlog_full, Retry-After) and nothing is written', async (t) => {
  const b = await bootBot(t, { botOptions: { maxUnacked: 3 } });
  for (const text of ['a', 'b', 'c']) assert.equal((await send(b, text)).status, 202);
  const before = await readFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), 'utf8');
  const r = await send(b, 'overflow'); assert.equal(r.status, 503); assert.equal((await r.json()).code, 'bot_backlog_full'); assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal(await readFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), 'utf8'), before, 'nothing written');
  const chat = await b.h.call('/api/agents/helper/chat', { data: { messages: [{ role: 'user', content: 'x' }] } }); assert.equal(chat.status, 503); await chat.body?.cancel();
  const c = await b.connect(); await c.next((x) => x.t === 'hello'); await c.until(() => news(c).length === 3); assert.deepEqual(news(c).map((e) => e.text), ['a', 'b', 'c']);
  await c.request({ t: 'ack', id: 'k', event_id: 1 }); assert.equal((await send(b, 'now fits')).status, 202);
  const live = await (await b.h.call('/api/agents/helper/runs')).json(); assert.ok(live.runs.every((r) => r.state !== 'running' || r.session_id), 'sanity');
});
