import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, addBot, member, PW, sseReader } from './bot-helpers.js';
const V11 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1' } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=', 'base64');
const createChat = async (b) => (await (await b.h.call('/api/agents/helper/sessions', { data: {} })).json()).id;
const upload = (b, chat, bytes = PNG, token = b.token, suffix = '') => fetch(b.h.base + '/api/bot/media' + suffix, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Chat-Id': chat, 'X-Foxfleet-Name': 'picture.exe' }, body: bytes });
const files = (b) => readdir(path.join(b.h.dir, 'bot', `${b.botId}.media`)).catch(() => []);
const download = (b, id, token = b.token, headers = {}) => fetch(b.h.base + `/api/bot/media/${id}`, { headers: { Authorization: `Bot ${token}`, ...headers } });

test('PNG bytes stay on disk, scoped downloads and range; bot refs bind to account and attached messages', async (t) => {
  const b = await bootBot(t), c = await b.connect(V11), chat = await createChat(b);
  assert.ok((await c.next((x) => x.t === 'hello')).features.includes('media'));
  const r = await upload(b, chat); assert.equal(r.status, 201); const m = await r.json();
  assert.equal(m.name, 'picture.png'); assert.equal(m.mime, 'image/png');
  const file = path.join(b.h.dir, 'bot', `${b.botId}.media`, m.id);
  assert.deepEqual(await readFile(file), PNG); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const json = await readFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), 'utf8');
  assert.equal(json.includes(PNG.toString('base64')), false); assert.equal(json.includes('89504e470d0a1a0a'), false);
  const get = await download(b, m.id); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store'); assert.equal(get.headers.get('content-type'), 'application/octet-stream'); assert.deepEqual(Buffer.from(await get.arrayBuffer()), PNG);
  const range = await download(b, m.id, b.token, { Range: 'bytes=1-4' }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), PNG.subarray(1, 5));
  const other = await addBot(t, b.h, 'other'), alice = await member(b.h), foreign = await addBot(t, b.h, 'foreign', { token: alice.token });
  for (const token of [other.token, foreign.token]) { const denied = await download(b, m.id, token); assert.equal(denied.status, 404); assert.equal((await denied.text()).includes(PNG.toString('base64')), false); }
  const ref = `/bot-media/${m.id}/${m.name}`;
  assert.equal((await b.h.call('/api/agents/helper/media', { data: { ref } })).status, 404);
  const wrongChat = await createChat(b);
  const wrong = await c.request({ t: 'message.send', id: 'wrong', chat_id: wrongChat, text: '', media: [m.id] }); assert.equal(wrong.error.code, 'not_found');
  const sent = await c.request({ t: 'message.send', id: 'send', chat_id: chat, text: '', media: [m.id], idempotency_key: 'once' }); assert.equal(sent.ok, true);
  const replay = await c.request({ t: 'message.send', id: 'replay', chat_id: chat, text: '', media: [m.id], idempotency_key: 'once' }); assert.equal(replay.replayed, true);
  const runList = await (await b.h.call(`/api/agents/helper/runs?session_id=${chat}`)).json();
  const live = sseReader(await b.h.call(`/api/agents/helper/runs/${runList.runs[0].id}/events`));
  t.after(() => live.cancel());
  await live.until(() => live.deltas().join('').includes(`MEDIA:${ref}`));
  await live.cancel();
  const transcript = await (await b.h.call(`/api/agents/helper/sessions/${chat}/messages`)).json(); assert.ok(transcript.messages.some((m) => m.content.includes(`MEDIA:${ref}`)));
  const resolved = await b.h.call('/api/agents/helper/media', { data: { ref } }); assert.equal(resolved.status, 200); const link = await resolved.json();
  assert.equal((await b.h.call(link.url)).status, 200); assert.equal((await b.h.call(link.url, { token: alice.token })).status, 404);
  assert.equal((await b.h.call('/api/agents/helper/media', { token: alice.token, data: { ref } })).status, 404);
  assert.equal((await b.h.call('/api/agents/other/media', { data: { ref } })).status, 404);
  assert.equal((await b.h.call(`/api/agents/helper/sessions/${chat}`, { method: 'DELETE' })).status, 200); assert.equal((await download(b, m.id)).status, 404); assert.deepEqual(await files(b), []);
});

test('SVG, HTML, executable and over-cap uploads fail without blobs; exact path and JSON boundary', async (t) => {
  const b = await bootBot(t, { botOptions: { maxMediaBytes: 100 } }), chat = await createChat(b);
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('<html>Hello</html>'), Buffer.from('MZprogram')]) { assert.equal((await upload(b, chat, bytes)).status, 415); assert.deepEqual(await files(b), []); }
  assert.equal((await upload(b, chat, Buffer.alloc(101))).status, 413); assert.deepEqual(await files(b), []);
  assert.equal((await upload(b, chat, PNG, b.token, '?a=1')).status, 415);
  const r = await fetch(b.h.base + '/api/connections', { method: 'POST', headers: { Authorization: `Bearer ${b.h.token}`, 'Content-Type': 'application/octet-stream' }, body: PNG }); assert.equal(r.status, 415);
});

test('stream cap and per-bot quota fail cleanly including concurrent uploads', async (t) => {
  const b = await bootBot(t, { botOptions: { maxMediaBytes: 100, mediaQuotaBytes: PNG.length } }), chat = await createChat(b);
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(80)); c.enqueue(new Uint8Array(80)); c.close(); } });
  const r = await fetch(b.h.base + '/api/bot/media', { method: 'POST', headers: { Authorization: `Bot ${b.token}`, 'X-Foxfleet-Chat-Id': chat }, body, duplex: 'half' }); assert.equal(r.status, 413); assert.deepEqual(await files(b), []);
  const results = await Promise.all([upload(b, chat), upload(b, chat)]); assert.deepEqual(results.map((r) => r.status).sort(), [201, 413]); assert.equal((await files(b)).length, 1);
});

test('1.1 images reach bot via disk media; 1.0 replay uses attachment text only', async (t) => {
  const b = await bootBot(t), c = await b.connect(V11); await c.next((x) => x.t === 'hello');
  const content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }];
  const accepted = await b.h.call('/api/agents/helper/messages', { data: { messages: [{ role: 'user', content }] } }); assert.equal(accepted.status, 202);
  const ev = await c.next((x) => x.t === 'message.new'); assert.equal(ev.media.length, 1); assert.equal((await download(b, ev.media[0].id)).status, 200);
  const old = await b.connect(); const replay = await old.next((x) => x.t === 'message.new'); assert.equal('media' in replay, false); assert.match(replay.text, /cannot receive files/);
  assert.equal((await b.h.call('/api/agents/helper/messages', { data: { messages: [{ role: 'user', content }] } })).status, 400);
  const refused = await old.request({ t: 'message.send', id: 'v1-media', chat_id: ev.chat_id, text: 'x', media: [ev.media[0].id] });
  assert.equal(refused.error.code, 'unsupported');
  const reserved = await old.request({ t: 'media.upload', id: 'still-reserved' });
  assert.equal(reserved.error.code, 'unsupported');
});

test('valid upload burst does not spend per-IP login throttle', async (t) => {
  const b = await bootBot(t, { botOptions: { rate: { burst: 100, perSec: 100 } } }), chat = await createChat(b);
  for (let i = 0; i < 25; i++) assert.equal((await upload(b, chat)).status, 201);
  assert.equal((await b.h.call('/api/auth/login', { token: '', data: { username: 'owner1', password: PW, client: 'app' } })).status, 200);
});

test('expired uploads are not attachable and agent/account deletion removes media', async (t) => {
  const { writeFile } = await import('node:fs/promises');
  const b = await bootBot(t), chat = await createChat(b);
  const uploaded = await (await upload(b, chat)).json();
  const storePath = path.join(b.h.dir, 'bot', `${b.botId}.json`);
  // Simulate an old durable upload; restart cold-loads metadata without clock mocking.
  const json = JSON.parse(await readFile(storePath, 'utf8'));
  json.media[uploaded.id].created = Date.now() - 3600_001;
  await writeFile(storePath, JSON.stringify(json));
  await b.h.restart();
  const c = await b.connect(V11);
  const send = await c.request({ t: 'message.send', id: 'expired', chat_id: chat, text: '', media: [uploaded.id] });
  assert.equal(send.error.code, 'not_found'); assert.equal((await download(b, uploaded.id)).status, 404);
  const fresh = await upload(b, chat); assert.equal(fresh.status, 201); assert.equal((await files(b)).includes(uploaded.id), false);
  assert.equal((await b.h.call('/api/connections/helper', { method: 'DELETE' })).status, 200); assert.deepEqual(await files(b), []);
  const alice = await member(b.h), foreign = await addBot(t, b.h, 'foreign', { token: alice.token });
  const made = await (await b.h.call('/api/agents/foreign/sessions', { token: alice.token, data: {} })).json();
  const response = await upload(b, made.id, PNG, foreign.token); assert.equal(response.status, 201); const row = await response.json();
  const dir = path.join(b.h.dir, 'users', alice.id, 'bot', `${foreign.botId}.media`);
  assert.ok((await readdir(dir)).includes(row.id));
  assert.equal((await b.h.call(`/api/admin/users/${alice.id}`, { method: 'DELETE' })).status, 200);
  await assert.rejects(readdir(dir), { code: 'ENOENT' });
});
