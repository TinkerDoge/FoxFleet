// Room media (Task 6): explicit account + conversation grants, membership re-checked at every download.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, addBot, member } from './bot-helpers.js';

const V12 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const V11 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCWQAAAAASUVORK5CYII=', 'base64');
const ZIP = Buffer.from('504b0304140000000800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000', 'hex');
const roomId = async (h, title = 'Media', members = ['helper']) => {
  const r = await h.call('/api/conversations', { data: { title, member_ids: members } });
  assert.equal(r.status, 201);
  return r.json();
};
const upload = (h, id, bytes, { token = h.token, name = 'picture.exe' } = {}) => fetch(h.base + `/api/conversations/${id}/media`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Name': name },
  body: bytes,
});
const botUpload = (b, id, bytes, { token = b.token, suffix = '' } = {}) => fetch(b.h.base + '/api/bot/media' + suffix, {
  method: 'POST',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Chat': id, 'X-Foxfleet-Chat-Type': 'group', 'X-Foxfleet-Name': 'picture.exe' },
  body: bytes,
});
const botDownload = (h, id, token) => fetch(h.base + `/api/bot/media/${id}`, { headers: { Authorization: `Bot ${token}` } });
const roomDownload = (h, room, id, token = h.token, method = 'GET') => fetch(h.base + `/api/conversations/${room}/media/${id}`, { method, headers: { Authorization: `Bearer ${token}` } });
const send = (h, id, data) => h.call(`/api/conversations/${id}/messages`, { data });

test('owner upload -> room message -> authorized owner and member download the identical bytes, with a sniffed ZIP and .txt refusal', async (t) => {
  const boot = await bootBot(t);
  const room = await roomId(boot.h);
  const c = await boot.connect(V12);
  await c.next((x) => x.t === 'hello');
  const made = await upload(boot.h, room.id, PNG);
  assert.equal(made.status, 201);
  const row = await made.json();
  assert.match(row.id, /^fbm_[A-Za-z0-9_-]{24}$/);
  assert.equal(row.name, 'picture.png');
  assert.equal(row.mime, 'image/png');
  const file = path.join(boot.h.dir, 'conversations', `${room.id}.media`, row.id);
  assert.deepEqual(await readFile(file), PNG);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const disk = await readFile(path.join(boot.h.dir, 'conversations', `${room.id}.json`), 'utf8');
  assert.equal(disk.includes(PNG.toString('base64')), false, 'bytes never live inside the room JSON');

  const zip = await (await upload(boot.h, room.id, ZIP, { name: 'archive.exe' })).json();
  assert.equal(zip.name, 'archive.zip');
  assert.equal(zip.mime, 'application/zip');
  assert.equal(zip.kind, 'file');
  assert.equal((await upload(boot.h, room.id, Buffer.from('plain text, not a deliverable'))).status, 415);
  assert.equal((await upload(boot.h, room.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).status, 415);
  assert.deepEqual((await readdir(path.join(boot.h.dir, 'conversations', `${room.id}.media`))).sort(), [row.id, zip.id].sort());

  const sent = await send(boot.h, room.id, { text: 'picture', media: [row.id, zip.id] });
  assert.equal(sent.status, 202);
  const body = await sent.json();
  assert.deepEqual(body.message.media.map((m) => m.id), [row.id, zip.id]);
  assert.equal(body.message.media[0].kind, 'image');
  assert.equal(body.message.media[1].kind, 'file');

  const history = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.deepEqual(history.messages.find((m) => m.id === body.message.id).media.map((m) => m.id), [row.id, zip.id]);

  const got = await roomDownload(boot.h, room.id, row.id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('cache-control'), 'no-store');
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.equal(got.headers.get('x-foxfleet-mime'), 'image/png');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
  const head = await roomDownload(boot.h, room.id, row.id, boot.h.token, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(PNG.length));

  const fromBot = await botDownload(boot.h, row.id, boot.token);
  assert.equal(fromBot.status, 200);
  assert.deepEqual(Buffer.from(await fromBot.arrayBuffer()), PNG);
  c.end();

  // The bytes and the grant survive a client reconnect and a hub restart.
  const again = await boot.connect(V12);
  await again.next((x) => x.t === 'hello');
  const replay = await botDownload(boot.h, row.id, boot.token);
  assert.equal(replay.status, 200);
  assert.deepEqual(Buffer.from(await replay.arrayBuffer()), PNG);
  again.end();
  await boot.h.restart();
  const cold = await boot.connect(V12);
  await cold.next((x) => x.t === 'hello');
  const afterRestart = await botDownload(boot.h, row.id, boot.token);
  assert.equal(afterRestart.status, 200);
  assert.deepEqual(Buffer.from(await afterRestart.arrayBuffer()), PNG);
});

test('nonmember, other account, removed member, revoked/deleted grant and DM ids all refuse without leaking bytes', async (t) => {
  const boot = await bootBot(t), h = boot.h;
  const other = await addBot(t, h, 'other');
  const alice = await member(h, 'alice');
  const room = await roomId(h);
  const row = await (await upload(h, room.id, PNG)).json();
  await send(h, room.id, { text: 'shared', media: [row.id] });

  assert.equal((await botDownload(boot.h, row.id, other.token)).status, 404, 'a bot of the same account but not in the room');
  assert.equal((await roomDownload(h, room.id, row.id, alice.token)).status, 404, 'another account cannot see the room');
  assert.equal((await h.call(`/api/conversations/${room.id}/media/${row.id}`, { token: alice.token })).status, 404);

  // A DM chat id upload is a different grant namespace, even for the same bot.
  const dm = await (await h.call('/api/agents/helper/sessions', { data: {} })).json();
  const dmRow = await (await fetch(h.base + '/api/bot/media', {
    method: 'POST', headers: { Authorization: `Bot ${boot.token}`, 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Chat': dm.id }, body: PNG,
  })).json();
  assert.equal((await roomDownload(h, room.id, dmRow.id)).status, 404);
  assert.equal((await roomDownload(h, room.id, row.id)).status, 200);

  const removed = await h.call(`/api/conversations/${room.id}/members/agent:helper`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await botDownload(boot.h, row.id, boot.token)).status, 404, 'membership is checked again at download');
  assert.equal((await roomDownload(h, room.id, row.id)).status, 200, 'the human owner still reads retained room history');
  await h.call(`/api/conversations/${room.id}/members/agent:helper`, { method: 'PUT' });
  assert.equal((await botDownload(boot.h, row.id, boot.token)).status, 200, 'a re-added member is a current grant again');

  const revoked = await h.call(`/api/conversations/${room.id}/media/${row.id}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.equal((await roomDownload(h, room.id, row.id)).status, 404);
  assert.equal((await botDownload(boot.h, row.id, boot.token)).status, 404);
  await assert.rejects(readFile(path.join(h.dir, 'conversations', `${room.id}.media`, row.id)), { code: 'ENOENT' });
  assert.equal((await h.call(`/api/conversations/${room.id}/media/${row.id}`, { method: 'DELETE' })).status, 200, 'a second revoke is idempotent');
  assert.equal((await h.call(`/api/conversations/${room.id}/messages`, { data: { text: 'x', media: [row.id] } })).status, 404, 'a revoked grant can never be attached again');
});

test('a 1.2 bot may upload and send room media; a 1.1 socket never uploads group media and the HTTP RPC path stays DM-only', async (t) => {
  const boot = await bootBot(t), h = boot.h;
  const room = await roomId(h);
  let c = await boot.connect(V12);
  await c.next((x) => x.t === 'hello');
  const made = await botUpload(boot, room.id, PNG);
  assert.equal(made.status, 201);
  const row = await made.json();
  assert.match(row.id, /^fbm_[A-Za-z0-9_-]{24}$/);
  assert.equal((await botDownload(boot.h, row.id, boot.token)).status, 404, 'an unattached upload is not readable');
  assert.equal((await send(h, room.id, { text: 'owner cannot spend it', media: [row.id] })).status, 404, 'a grant belongs to the actor that uploaded it');

  const sent = await c.request({ t: 'message.send', id: 'media-send', chat_id: room.id, text: 'from the bot', media: [row.id] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const listed = await (await h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.deepEqual(listed.messages.find((m) => m.id === sent.result.message_id).media.map((m) => m.id), [row.id]);
  const got = await botDownload(boot.h, row.id, boot.token);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);

  const old = await boot.connect(V11);
  await old.next((x) => x.t === 'hello');
  assert.equal((await botUpload(boot, room.id, PNG, { suffix: '?v=1' })).status, 415, 'the upload path is exact');
  const refused = await fetch(h.base + '/api/bot/media', {
    method: 'POST',
    headers: { Authorization: `Bot ${boot.token}`, 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Chat': room.id, 'X-Foxfleet-Chat-Type': 'group', 'X-Foxfleet-Name': 'late.png' },
    body: PNG,
  });
  assert.equal(refused.status, 404, 'a 1.1 socket cannot mint room media');
  const rpc = await fetch(h.base + '/api/bot/rpc', {
    method: 'POST',
    headers: { Authorization: `Bot ${boot.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: 'message.send', id: 'room-over-http', chat_id: room.id, text: 'x', media: [row.id] }),
  });
  assert.equal(rpc.status, 200);
  const body = await rpc.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'unsupported');
});
