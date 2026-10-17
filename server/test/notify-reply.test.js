// Notification direct reply and mark-read (0.4.0, docs/LIVE-EVENTS.md): idempotency keys, reply tokens (scope, forgery, expiry,
// revoked device: always 403 reply_token_invalid, never 401), rate limit, text limit, mark_read, and the ?reply=1 token minting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replyTokens } from '../reply-tokens.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hub, hermes, sse, login, until, PASS } from './live2-helpers.js';

const TRANSCRIPT = [{ id: 1, role: 'user', content: 'can you check the build?' }, { id: 2, role: 'assistant', content: 'The build is green. Deploy?' }];
async function setup(t, opts = {}) {
  const { mock, opts: h } = await hermes(t, { messages: TRANSCRIPT, sessions: [] });
  const x = await hub(t, { password: PASS, ...opts }); const a = await login(x.base), b = await login(x.base);
  assert.equal((await x.call('/api/connections', { ...mock.connection, name: 'atlas' }, { headers: a.h })).status, 201);
  return { ...x, a, b, mock, h, reply: (body, headers = a.h) => x.call('/api/notify/reply', body, { headers }) };
}

test('reply tokens: HMAC-signed, scoped claims, expiry, forgery; key file is private', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-rt-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1_000_000; const file = path.join(dir, 'reply-token.key'), tk = await replyTokens(file, { now: () => now });
  assert.equal(statSync(file).mode & 0o777, 0o600); assert.match(await readFile(file, 'utf8'), /^[A-Za-z0-9_-]{43}$/);
  const { token, expires_at } = tk.mint({ user: 'u1', device: 'd1', agent: 'atlas', chat: 's1' }); assert.equal(expires_at, now + 24 * 3600_000); assert.ok(token.length <= 512);
  assert.deepEqual(tk.verify(token), { user: 'u1', device: 'd1', agent: 'atlas', chat: 's1', expires: expires_at });
  const [p, sig] = token.split('.'); const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), c: 'other' })).toString('base64url') + '.' + sig;
  for (const bad of [forged, token + 'x', 'abc', '', null, token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))]) assert.equal(tk.verify(bad), null, String(bad).slice(0, 20));
  assert.equal((await replyTokens(file, { now: () => now })).verify(token)?.chat, 's1', 'the key survives a restart');
  assert.equal((await replyTokens(path.join(dir, 'other.key'), { now: () => now })).verify(token), null, 'another hub key rejects it');
  now = expires_at; assert.equal(tk.verify(token), null, 'expired');
});

test('reply with the device session: 202 with the message; same key replays (200 duplicate), other body 409; key and text validation; chat is marked read', async (t) => {
  const x = await setup(t), s = sse(t, `${x.base}/api/live/stream?v=2`, x.a.h); await s.wait((f) => f.event === 'foxfleet.ready');
  const ok = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'Yes, go ahead', idempotency_key: 'k-00000001' });
  assert.equal(ok.status, 202, JSON.stringify(ok.body)); assert.equal(ok.body.duplicate, false); assert.equal(ok.body.session_id, 'sess-1');
  assert.equal(ok.body.message.text, 'Yes, go ahead'); assert.equal(ok.body.message.source, 'notification'); assert.equal(ok.body.message.n, 3); assert.equal(ok.body.message.role, 'user');
  assert.ok(['sent', 'delivered', 'read'].includes(ok.body.message.status)); assert.ok(ok.body.run_id, 'the reply started at once');
  const mine = await s.wait((f) => f.event === 'message.new' && f.data.message.source === 'notification'); assert.equal(mine.data.message.hub_id, ok.body.message.hub_id);
  await s.wait((f) => f.event === 'run.finished');
  const dup = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'Yes, go ahead', idempotency_key: 'k-00000001' });
  assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true); assert.equal(dup.body.message.hub_id, ok.body.message.hub_id); assert.equal(dup.body.message.text, 'Yes, go ahead'); assert.equal(dup.body.run_id, ok.body.run_id);
  const viaHeader = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'Yes, go ahead' }, { ...x.a.h, 'Idempotency-Key': 'k-00000001' }); assert.equal(viaHeader.status, 200); assert.equal(viaHeader.body.duplicate, true);
  const conflict = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'No, wait', idempotency_key: 'k-00000001' }); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'idempotency_conflict');
  assert.equal(s.events('message.new').filter((f) => f.data.message.source === 'notification').length, 1, 'one message for one key');
  for (const [body, headers] of [[{ agent: 'atlas', chat: 'sess-1', text: 'x' }, x.a.h], [{ agent: 'atlas', chat: 'sess-1', text: 'x', idempotency_key: 'short' }, x.a.h], [{ agent: 'atlas', chat: 'sess-1', text: 'x', idempotency_key: 'has space here' }, x.a.h], [{ agent: 'atlas', chat: 'sess-1', text: 'x', idempotency_key: 'k-aaaaaaaa' }, { ...x.a.h, 'Idempotency-Key': 'k-bbbbbbbb' }]]) {
    const r = await x.reply(body, headers); assert.equal(r.status, 400); assert.equal(r.body.code, 'invalid_idempotency_key');
  }
  const long = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'a'.repeat(32_001), idempotency_key: 'k-long0001' }); assert.equal(long.status, 413); assert.equal(long.body.code, 'text_too_long');
  assert.equal((await x.reply({ agent: 'atlas', chat: 'sess-1', text: '   ', idempotency_key: 'k-empty001' })).status, 400);
  for (const body of [{ agent: 'nobody', chat: 'sess-1' }, { agent: 'atlas', chat: '../x' }]) { const r = await x.reply({ ...body, text: 'hi', idempotency_key: 'k-nf000001' }); assert.equal(r.status, 404); assert.equal(r.body.code, 'chat_not_found'); }
  const row = (await x.call('/api/chats/atlas', undefined, { headers: x.a.h })).body; assert.ok(row.read_up_to >= 3, 'replying read the chat');
});

test('reply token from ?reply=1 works without the session, only for its chat; forged, other-chat and revoked-device tokens are 403 reply_token_invalid (never 401)', async (t) => {
  const x = await setup(t);
  const plain = sse(t, `${x.base}/api/notify/stream`, x.a.h), withTok = sse(t, `${x.base}/api/notify/stream?reply=1`, x.a.h);
  await withTok.wait((f) => f.event === 'foxfleet.ready'); await plain.wait((f) => f.event === 'foxfleet.ready');
  await x.call('/api/agents/atlas/messages', { messages: [{ role: 'user', content: 'status?' }], session_id: 'sess-1' }, { headers: x.a.h });
  const ev = await withTok.wait((f) => f.event === 'notify' && f.data.type === 'reply_finished');
  assert.match(ev.data.reply.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/); assert.ok(ev.data.reply.expires_at > Date.now() + 23 * 3600_000);
  const pe = await plain.wait((f) => f.event === 'notify' && f.data.type === 'reply_finished'); assert.equal(pe.data.reply, undefined, 'no token unless asked');
  const tok = { 'X-Foxfleet-Reply-Token': ev.data.reply.token };
  const ok = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'thanks', idempotency_key: 'tok-000001' }, tok); assert.equal(ok.status, 202, JSON.stringify(ok.body));
  const rd = await x.call('/api/notify/read', { agent: 'atlas', chat: 'sess-1' }, { headers: tok }); assert.equal(rd.status, 200); assert.equal(rd.body.unread_count, 0); assert.equal(rd.body.chat, 'sess-1');
  assert.equal((await x.call('/api/notify/read', { agent: 'atlas', chat: 'sess-1', up_to: 0 }, { headers: tok })).body.code, 'invalid_read_position');
  const badBearer = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'thanks', idempotency_key: 'tok-000001' }, { ...tok, Authorization: 'Bearer expired.token' }); assert.equal(badBearer.status, 200, 'a dead session plus a good token still works');
  const other = await x.reply({ agent: 'atlas', chat: 'sess-2', text: 'x', idempotency_key: 'tok-000002' }, tok); assert.equal(other.status, 403); assert.equal(other.body.code, 'reply_token_invalid');
  const forged = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'x', idempotency_key: 'tok-000003' }, { 'X-Foxfleet-Reply-Token': ev.data.reply.token.slice(0, -2) + 'AA' }); assert.equal(forged.status, 403); assert.equal(forged.body.code, 'reply_token_invalid');
  const nothing = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'x', idempotency_key: 'tok-000004' }, {}); assert.equal(nothing.status, 401, 'no credential at all is the normal login error');
  const onlyToken = await x.call('/api/chats', undefined, { headers: tok }); assert.equal(onlyToken.status, 401, 'a reply token opens nothing else');
  const del = await x.call(`/api/auth/devices/${x.a.device}`, undefined, { method: 'DELETE', headers: x.b.h }); assert.equal(del.status, 200);
  const revoked = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'x', idempotency_key: 'tok-000005' }, tok); assert.equal(revoked.status, 403); assert.equal(revoked.body.code, 'reply_token_invalid');
  assert.equal((await x.call('/api/notify/read', { agent: 'atlas', chat: 'sess-1' }, { headers: tok })).status, 403);
});

test('reply: rate limit 429 rate_limited with Retry-After; replays do not count; concurrent same-key requests send once', async (t) => {
  const x = await setup(t, { replyRatePerMin: 2 });
  const s = sse(t, `${x.base}/api/live/stream?v=2`, x.a.h); await s.wait((f) => f.event === 'foxfleet.ready');
  const [p, q] = await Promise.all([x.reply({ agent: 'atlas', chat: 'sess-1', text: 'same', idempotency_key: 'race-0001' }), x.reply({ agent: 'atlas', chat: 'sess-1', text: 'same', idempotency_key: 'race-0001' })]);
  assert.deepEqual([p.status, q.status].sort(), [200, 202]); assert.equal(p.body.message.hub_id, q.body.message.hub_id);
  assert.equal((await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'same', idempotency_key: 'race-0001' })).status, 200);
  assert.equal((await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'two', idempotency_key: 'rate-0002' })).status, 202);
  const over = await x.reply({ agent: 'atlas', chat: 'sess-1', text: 'three', idempotency_key: 'rate-0003' });
  assert.equal(over.status, 429); assert.equal(over.body.code, 'rate_limited'); assert.ok(Number(over.headers.get('retry-after')) >= 1);
  await until(() => s.events('message.new').filter((f) => f.data.message.source === 'notification').length === 2);
  assert.equal(s.events('message.new').filter((f) => f.data.message.source === 'notification').length, 2);
});
