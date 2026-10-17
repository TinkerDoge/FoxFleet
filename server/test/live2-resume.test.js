// 0.4.0 audit fixes (Soran, 70a0140): replays of any size reach ready (paged, drain-aware; the 1 MiB drop is for the live phase
// only), aged-out cursors on an idle hub are an expired gap / 410, retention boundaries, byte cap in UTF-8 bytes with a bounded
// file, second-account isolation, and rate-limit slots only for replies that are really sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { liveLog, attachLive2Stream } from '../live2.js';
import { hub, hermes, sse, login, until, sleep, listen, PASS } from './live2-helpers.js';

const DAY = 86_400_000;
const tmp = async (t) => { const d = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-l2r-')); t.after(() => rm(d, { recursive: true, force: true })); return path.join(d, 'live-events'); };

/** A bare HTTP server around one log, like the hub's route. */
async function streamServer(t, log, opts = {}) {
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); attachLive2Stream(req, res, log, { cursor: u.searchParams.get('since') ?? '', ...opts }); });
  const base = await listen(server); t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  return base;
}
/** Raw SSE read: pauses `pauseMs` after the first chunk (a slow phone), then reads to `foxfleet.ready`. Returns { ids, frames, bytes }. */
function readUntilReady(url, { pauseMs = 0, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = '', bytes = 0, paused = false; const ids = [], frames = [];
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`no ready after ${ids.length} ids, ${bytes} bytes`)); }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (c) => {
        bytes += Buffer.byteLength(c); buf += c;
        if (pauseMs && !paused) { paused = true; res.pause(); setTimeout(() => res.resume(), pauseMs); }
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2); const f = { id: null, event: null, data: null };
          for (const l of raw.split('\n')) { if (l.startsWith('id: ')) f.id = l.slice(4); else if (l.startsWith('event: ')) f.event = l.slice(7); else if (l.startsWith('data: ')) f.data = JSON.parse(l.slice(6)); }
          frames.push(f); if (f.id) ids.push(Number(f.id.split(':')[1]));
          if (f.event === 'foxfleet.ready') { clearTimeout(timer); req.destroy(); return resolve({ ids, frames, bytes }); }
        }
      });
      res.on('error', () => {}); res.on('close', () => { clearTimeout(timer); reject(new Error(`closed after ${ids.length} ids, ${bytes} bytes, no ready`)); });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET' || !req.destroyed) reject(e); });
  });
}

test('replay over 1 MiB: a slow client gets every page in order, then events emitted during the replay, then ready; nothing twice', async (t) => {
  const log = await liveLog(await tmp(t), { retainEvents: 20_000 }); t.after(() => log.close());
  const text = 'é'.repeat(4000); // 8 KB of UTF-8 per event
  for (let i = 0; i < 600; i++) log.emit('message.new', { agent: 'a', chat: 's', message: { n: i + 1, text } }); // ~4.8 MiB
  const store = log.store, base = await streamServer(t, log);
  const during = setInterval(() => log.emit('chat.updated', { agent: 'a' }), 5); // live events keep coming while the replay drains
  let got; try { got = await readUntilReady(`${base}/?since=${store}:0`, { pauseMs: 300 }); } finally { clearInterval(during); }
  assert.ok(got.bytes > 4 * 1024 * 1024, `the whole replay arrived (${got.bytes} bytes)`);
  assert.equal(got.frames.find((f) => f.event === 'foxfleet.gap'), undefined, 'no gap');
  assert.ok(got.ids.length >= 600); assert.deepEqual(got.ids, Array.from({ length: got.ids.length }, (_, i) => i + 1), 'every seq from 1, in order, no duplicate');
  const ready = got.frames.at(-1); assert.equal(ready.event, 'foxfleet.ready'); assert.equal(ready.data.cursor, `${store}:${got.ids.at(-1)}`);
  // the default retention (5000 events) of realistic rows, read at full speed
  const log2 = await liveLog(await tmp(t)); t.after(() => log2.close());
  for (let i = 0; i < 5000; i++) log2.emit('chat.updated', { agent: 'a', row: { agent: 'a', label: 'Atlas', last_message: { preview: 'x'.repeat(400) }, unread_count: i } });
  const all = await readUntilReady(`${await streamServer(t, log2)}/?since=${log2.store}:0`);
  assert.equal(all.ids.length, 5000); assert.ok(all.bytes > 2 * 1024 * 1024);
});

test('live phase: a viewer more than 1 MiB behind is still dropped (it resumes by id); a stalled replay gives up after drainMs', async (t) => {
  const log = await liveLog(await tmp(t)); t.after(() => log.close());
  const base = await streamServer(t, log, { drainMs: 300 });
  const closed = (url, onReady) => new Promise((resolve) => {
    const req = http.get(url, (res) => { let buf = '', fired = false; res.setEncoding('utf8'); res.socket.once('close', () => resolve(true)); res.on('data', (c) => { buf += c; if (!fired && buf.includes('foxfleet.ready')) { fired = true; res.pause(); onReady?.(); } }); res.on('error', () => {}); });
    req.on('error', () => resolve(true));
  });
  const big = { agent: 'a', chat: 's', message: { text: 'x'.repeat(60_000) } };
  const live = closed(`${base}/`, () => { for (let i = 0; i < 400; i++) log.emit('message.new', big); }); // ~24 MB to a viewer that reads nothing
  assert.equal(await Promise.race([live, sleep(10_000).then(() => false)]), true, 'dropped in the live phase');
  // a replay to a client that never reads: the stream gives up instead of holding the slot (seen on the hub side; a paused
  // client socket does not notice the close until it reads)
  const req = http.get(`${base}/?since=${log.store}:0`, (res) => res.pause()); req.on('error', () => {}); t.after(() => req.destroy());
  await until(() => log.streams === 1); await until(() => log.streams === 0, { tries: 100, ms: 50 });
});

test('retention boundaries: count (oldest first), exactly N days kept and N days + 1 ms dropped, an idle log ages out on read', async (t) => {
  let now = 10 * DAY; const log = await liveLog(await tmp(t), { now: () => now, retainEvents: 100, retainDays: 7 }); t.after(() => log.close());
  for (let i = 0; i < 100; i++) log.emit('chat.updated', { agent: 'a' });
  assert.equal(log.floor, 0); assert.equal(log.parse(`${log.store}:0`).kind, 'ok');
  log.emit('chat.updated', { agent: 'a' }); // the 101st evicts seq 1
  assert.equal(log.floor, 1); assert.equal(log.parse(`${log.store}:0`).kind, 'expired'); assert.equal(log.parse(`${log.store}:1`).kind, 'ok');
  assert.equal(log.since(1).entries[0].seq, 2); assert.equal(log.since(0).expired, true);
  const at = now; now = at + 7 * DAY; // exactly 7 days: kept
  assert.equal(log.parse(`${log.store}:1`).kind, 'ok'); assert.equal(log.size, 100);
  now = at + 7 * DAY + 1; // 1 ms more: everything aged out, with no emit in between (idle hub)
  assert.equal(log.parse(`${log.store}:1`).kind, 'expired', 'an aged-out cursor is a gap, not an empty ok');
  assert.equal(log.parse(`${log.store}:100`).kind, 'expired'); assert.equal(log.parse(log.cursor).kind, 'ok', 'the newest cursor itself is fine');
  assert.equal(log.size, 0); assert.equal(log.floor, 101);
});

test('idle hub: an aged-out cursor gets a 410 from the pull and an expired gap (no events) on the stream', async (t) => {
  let now = Date.now(); const x = await hub(t, { liveClock: () => now }), { mock } = await hermes(t, { messages: [{ id: 1, role: 'user', content: 'q' }, { id: 2, role: 'assistant', content: 'a' }], sessions: [] });
  await x.call('/api/connections', { ...mock.connection, name: 'atlas' });
  const start = (await x.call('/api/chats')).body.cursor;
  await x.call('/api/chats/atlas/archive', { archived: true }, { method: 'PUT' }); await x.call('/api/chats/atlas/archive', { archived: false }, { method: 'PUT' });
  const fresh = await x.call(`/api/live/events?since=${start}`); assert.equal(fresh.status, 200); assert.ok(fresh.body.events.length >= 2);
  now += 8 * DAY; // nothing happens on the hub for 8 days
  const pull = await x.call(`/api/live/events?since=${start}`); assert.equal(pull.status, 410); assert.equal(pull.body.code, 'cursor_expired'); assert.ok(pull.body.cursor);
  const s = sse(t, `${x.base}/api/live/stream?v=2&since=${start}`); const ready = await s.wait((f) => f.event === 'foxfleet.ready');
  const gap = s.frames.find((f) => f.event === 'foxfleet.gap'); assert.equal(gap?.data.reason, 'expired'); assert.equal(s.events().length, 0); assert.equal(ready.data.cursor, gap.data.cursor);
  assert.equal((await x.call(`/api/live/events?since=${ready.data.cursor}`)).status, 200, 'the cursor from the gap works');
});

test('byte cap counts UTF-8 bytes, and the file on disk stays within about twice the cap', async (t) => {
  const base = await tmp(t), cap = 100_000, log = await liveLog(base, { retainEvents: 100, maxBytes: cap }); t.after(() => log.close());
  for (let i = 0; i < 400; i++) { log.emit('message.new', { agent: 'a', chat: 's', message: { text: (i % 2 ? 'Tiếng Việt có dấu ' : '日本語のテキスト').repeat(60) } }); if (i % 20 === 0) await log.flush(); }
  await log.flush();
  const held = log.since(log.floor, 1000).entries.reduce((n, e) => n + Buffer.byteLength(e.line) + 1, 0);
  assert.equal(log.bytes, held); assert.ok(held <= cap, `held ${held} UTF-8 bytes, cap ${cap}`);
  const { size } = await stat(base + '.jsonl'); assert.ok(size <= cap * 2 + 64 * 1024, `file ${size} bytes`);
  await log.close(); const again = await liveLog(base, { retainEvents: 100, maxBytes: cap }); t.after(() => again.close()); assert.equal(again.size, log.size, 'read back line by line');
});

test('two accounts: separate stores and events; the other account gets 404 on every chat route, a reset gap and 410 with a foreign cursor', async (t) => {
  const { mock } = await hermes(t, { messages: [{ id: 1, role: 'user', content: 'private plan' }, { id: 2, role: 'assistant', content: 'ok' }], sessions: [] });
  const x = await hub(t, { password: PASS }); await x.server.accounts.createUser('bob', PASS, 'user', { skipPolicy: true });
  const a = await login(x.base);
  const r = await fetch(x.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: PASS, client: 'app' }) });
  const bt = await r.json(); assert.equal(r.status, 200); const b = { Authorization: `Bearer ${bt.token}` };
  assert.equal((await x.call('/api/connections', { ...mock.connection, name: 'atlas' }, { headers: a.h })).status, 201);
  const sa = sse(t, `${x.base}/api/live/stream?v=2`, a.h), sb = sse(t, `${x.base}/api/live/stream?v=2`, b);
  const ra = await sa.wait((f) => f.event === 'foxfleet.ready'), rb = await sb.wait((f) => f.event === 'foxfleet.ready'); assert.notEqual(ra.data.store, rb.data.store);
  assert.equal((await x.call('/api/agents/atlas/messages', { messages: [{ role: 'user', content: 'A only' }], session_id: 'sess-1' }, { headers: a.h })).status, 202);
  await sa.wait((f) => f.event === 'run.finished', 8000); await sleep(200);
  assert.equal(sb.frames.filter((f) => f.id || f.event === 'typing').length, 0, 'nothing of A reaches B');
  for (const [p, body, method] of [['/api/chats/atlas'], ['/api/chats/atlas/read', { chat: 'sess-1', up_to: 1 }], ['/api/chats/atlas/archive', { archived: true }, 'PUT'], ['/api/chats/atlas/unread', { unread: true }, 'PUT'], ['/api/notify/read', { agent: 'atlas', chat: 'sess-1' }], ['/api/notify/reply', { agent: 'atlas', chat: 'sess-1', text: 'hi', idempotency_key: 'bob-00001' }]]) {
    const res = await x.call(p, body, { method, headers: b }); assert.equal(res.status, 404, p); assert.equal(res.body.code, 'chat_not_found', p);
  }
  const lb = await x.call('/api/chats', undefined, { headers: b }); assert.equal(lb.body.chats.length, 0); assert.equal(lb.body.total_unread, 0);
  const foreign = ra.data.cursor.replace(/:\d+$/, ':0');
  assert.equal((await x.call(`/api/live/events?since=${foreign}`, undefined, { headers: b })).status, 410);
  const g = sse(t, `${x.base}/api/live/stream?v=2&since=${foreign}`, b); await g.wait((f) => f.event === 'foxfleet.ready');
  assert.equal(g.frames.find((f) => f.event === 'foxfleet.gap')?.data.reason, 'reset'); assert.equal(g.events().length, 0);
  assert.ok(sa.events('message.new').length >= 2, 'A saw its own messages');
});

test('reply rate limit: a 409 (bot agent) or a 404 chat_not_found (both history paths 404) does not use a slot; replays do not either', async (t) => {
  const { mock } = await hermes(t, { messages: [{ id: 1, role: 'user', content: 'q' }, { id: 2, role: 'assistant', content: 'a' }], sessions: [] });
  const x = await hub(t, { replyRatePerMin: 1, botApi: true, botAgents: '*' });
  assert.equal((await x.call('/api/connections', { ...mock.connection, name: 'atlas' })).status, 201);
  assert.equal((await x.call('/api/connections', { kind: 'hermes', connection: 'bot', name: 'helper' })).status, 201);
  const gone = async (req, res, route) => { if (!/\/sessions\/[^/]+\/messages$/.test(route)) return false; res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return true; };
  const { mock: empty } = await hermes(t, { noDashboardMessages: true, sessions: [], apiRoute: gone }); // cannot load any session
  assert.equal((await x.call('/api/connections', { ...empty.connection, name: 'ghost' })).status, 201);
  for (let i = 0; i < 3; i++) assert.equal((await x.call('/api/notify/reply', { agent: 'helper', chat: 'sess-1', text: 'hi', idempotency_key: `bot-key-${i}0` })).status, 409);
  for (let i = 0; i < 3; i++) { const r = await x.call('/api/notify/reply', { agent: 'ghost', chat: 'sess-9', text: 'hi', idempotency_key: `nf-key-${i}0` }); assert.equal(r.status, 404, JSON.stringify(r.body)); assert.equal(r.body.code, 'chat_not_found'); }
  for (const [p, body] of [['/api/notify/read', { agent: 'ghost', chat: 'sess-9' }], ['/api/chats/ghost/read', { chat: 'sess-9', up_to: 1 }]]) { const r = await x.call(p, body); assert.equal(r.status, 404, p); assert.equal(r.body.code, 'chat_not_found', p); }
  assert.equal((await x.call('/api/agents/ghost/sessions/sess-9/messages')).status, 502, 'history itself keeps its 502 upstream_error');
  const ok = await x.call('/api/notify/reply', { agent: 'atlas', chat: 'sess-1', text: 'go', idempotency_key: 'real-key-1' }); assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal((await x.call('/api/notify/reply', { agent: 'atlas', chat: 'sess-1', text: 'go', idempotency_key: 'real-key-1' })).status, 200, 'replay');
  const over = await x.call('/api/notify/reply', { agent: 'atlas', chat: 'sess-1', text: 'again', idempotency_key: 'real-key-2' }); assert.equal(over.status, 429); assert.equal(over.body.code, 'rate_limited');
});

test('idempotency keys are kept 24 h: far more than 500 keys in a day are all still answered as replays', async (t) => {
  const { chatLedger } = await import('../ledger.js');
  let now = 1_000_000; const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-l2r-')); const L = await chatLedger(path.join(dir, 'chats.json'), { now: () => now });
  t.after(async () => { await L.close(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 2000; i++) { L.idem.put(`key-${i}-0000`, 'h' + i, { duplicate: false }); now += 40_000; } // 2000 replies over ~22 h (within 30/min)
  assert.equal(L.idem.get('key-0-0000')?.h, 'h0', 'the first key of the day is still known');
  now += 3 * 3_600_000; assert.equal(L.idem.get('key-0-0000'), null, 'after 24 h it is gone'); assert.equal(L.idem.get('key-1999-0000')?.h, 'h1999');
});
