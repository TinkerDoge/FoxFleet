// Live events v2 (0.4.0): the persistent per-account log (seq that survives restarts, store id, retention, gap reasons,
// crash safety, compaction) and the v2 SSE stream (replay, gap, ready, typing, heartbeat, sign-out, shared stream limit).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { liveLog, attachLive2Stream, retentionFromEnv, LIVE2_TYPES } from '../live2.js';
import { liveBus, attachLiveStream } from '../live.js';
import { sse, listen, sleep } from './live2-helpers.js';

async function tmp(t) { const d = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-l2-')); t.after(() => rm(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })); return path.join(d, 'live-events'); }
async function streamServer(t, log, opts = {}) {
  const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); try { attachLive2Stream(req, res, log, { cursor: u.searchParams.get('since') ?? req.headers['last-event-id'] ?? '', ...opts }); } catch (e) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: e.code })); } });
  const base = await listen(s); t.after(() => { s.closeAllConnections(); return new Promise((r) => s.close(r)); }); return base;
}

test('log: seq increases, events keep their fields, unknown types throw, typing is never stored', async (t) => {
  const base = await tmp(t), log = await liveLog(base); t.after(() => log.close());
  assert.match(log.store, /^[A-Za-z0-9_-]{12}$/); assert.equal(log.seq, 0); assert.equal(log.cursor, `${log.store}:0`);
  const a = log.emit('message.new', { agent: 'atlas', chat: 's1', message: { hub_id: 'h1', text: 'hi' }, skip: undefined });
  assert.deepEqual(Object.keys(a), ['seq', 'type', 'at', 'agent', 'chat', 'message']); assert.equal(a.seq, 1);
  assert.equal(log.emit('read', { agent: 'atlas', chat: 's1', read_up_to: 1 }).seq, 2);
  assert.throws(() => log.emit('nope', {}), /unknown live event/);
  log.typing({ agent: 'atlas', chat: 's1', state: 'typing' }); assert.equal(log.seq, 2); assert.equal(log.size, 2);
  assert.deepEqual(log.since(1).entries.map((e) => e.seq), [2]); assert.equal(log.since(0, 1).hasMore, true);
  assert.deepEqual(LIVE2_TYPES.slice(0, 4), ['message.new', 'message.edited', 'message.deleted', 'message.status']);
});

test('log: cursor parsing gives none / invalid / reset (other store, future seq) / expired (below floor) / ok', async (t) => {
  const base = await tmp(t), log = await liveLog(base, { retainEvents: 3 }); t.after(() => log.close());
  for (let i = 0; i < 6; i++) log.emit('chat.updated', { agent: 'a' });
  assert.equal(log.floor, 3); assert.equal(log.size, 3);
  assert.deepEqual(log.parse(''), { kind: 'none' }); assert.deepEqual(log.parse(undefined), { kind: 'none' });
  for (const v of ['x y', '12', 'a:b', `${log.store}:-1`, `${log.store}:1e3`]) assert.equal(log.parse(v).kind, 'invalid', v);
  assert.equal(log.parse('otherstore1:2').kind, 'reset'); assert.equal(log.parse(`${log.store}:7`).kind, 'reset', 'future seq');
  assert.equal(log.parse(`${log.store}:2`).kind, 'expired'); assert.deepEqual(log.parse(`${log.store}:3`), { kind: 'ok', seq: 3 }); assert.deepEqual(log.parse(`${log.store}:6`), { kind: 'ok', seq: 6 });
});

test('log: a clean restart keeps store, events and the exact counter; after a crash no seq is reused and every older cursor is an expired gap; torn lines are skipped', async (t) => {
  const base = await tmp(t);
  const a = await liveLog(base); for (let i = 0; i < 3; i++) a.emit('chat.updated', { agent: 'a', i }); const store = a.store; await a.close();
  const b = await liveLog(base); assert.equal(b.store, store); assert.equal(b.seq, 3, 'clean shutdown: no jump'); assert.deepEqual(b.since(0).entries.map((e) => JSON.parse(e.line).i), [0, 1, 2]);
  assert.equal(b.parse(`${store}:1`).kind, 'ok', 'a clean restart resumes old cursors');
  b.emit('chat.updated', { agent: 'a', i: 3 }); await b.flush(); b.emit('chat.updated', { agent: 'a', i: 4 }); // 5 never reaches disk: the process "crashes" here
  await appendFile(base + '.jsonl', '{"seq":99,"type":"chat.upd'); // torn last line
  const c = await liveLog(base); t.after(() => c.close());
  assert.equal(c.store, store, 'same store: a crash is not a data reset');
  assert.ok(c.seq >= 4 + 1000 - 1, `counter resumes above the reserved block (got ${c.seq})`); assert.equal(c.floor, c.seq);
  for (const n of [0, 1, 3, 4, 5]) assert.equal(c.parse(`${store}:${n}`).kind, 'expired', `cursor ${n}: unflushed events may be lost, so the client resyncs`);
  assert.equal(c.parse(c.cursor).kind, 'ok');
  const e = c.emit('chat.updated', { agent: 'a' }); assert.ok(e.seq > 5); assert.deepEqual(c.since(c.floor).entries.map((x) => x.seq), [e.seq]);
});

test('log: unreadable meta starts a new store (old cursors are a reset); retention by days; env bounds', async (t) => {
  const base = await tmp(t); let now = 1_000_000;
  const a = await liveLog(base, { now: () => now, retainDays: 1 }); a.emit('chat.updated', { agent: 'a' }); const old = a.cursor; now += 2 * 86_400_000; a.emit('chat.updated', { agent: 'a' });
  assert.equal(a.size, 1, 'day-old event dropped'); assert.equal(a.parse(old.replace(/:\d+$/, ':0')).kind, 'expired'); await a.close();
  await writeFile(base + '.json', '{not json');
  const b = await liveLog(base); t.after(() => b.close()); assert.notEqual(b.store, old.split(':')[0]); assert.equal(b.seq, 0); assert.equal(b.parse(old).kind, 'reset');
  assert.deepEqual(retentionFromEnv({}), { retainEvents: 5000, retainDays: 7 });
  assert.deepEqual(retentionFromEnv({ FOXFLEET_LIVE_RETAIN_EVENTS: '250', FOXFLEET_LIVE_RETAIN_DAYS: '2' }), { retainEvents: 250, retainDays: 2 });
  assert.deepEqual(retentionFromEnv({ FOXFLEET_LIVE_RETAIN_EVENTS: '5', FOXFLEET_LIVE_RETAIN_DAYS: 'x' }), { retainEvents: 5000, retainDays: 7 });
});

test('log: the byte cap drops the oldest events; the file is compacted and stays private', async (t) => {
  const base = await tmp(t), log = await liveLog(base, { retainEvents: 100, maxBytes: 20_000 }); t.after(() => log.close());
  for (let i = 0; i < 1500; i++) log.emit('message.new', { agent: 'a', chat: 's', message: { text: 'x'.repeat(i % 7 === 0 ? 900 : 10) } });
  await log.flush();
  assert.ok(log.size <= 100); assert.ok(log.floor > 1300);
  const lines = (await readFile(base + '.jsonl', 'utf8')).split('\n').filter(Boolean).length; assert.ok(lines <= 100 * 2 + 1000, `compacted (${lines} lines)`);
  const { statSync } = await import('node:fs'); assert.equal(statSync(base + '.jsonl').mode & 0o777, 0o600); assert.equal(statSync(base + '.json').mode & 0o777, 0o600);
});

test('stream v2: ready (contract, store, cursor), live events with <store>:<seq> ids, typing without id, heartbeat', async (t) => {
  const log = await liveLog(await tmp(t)); t.after(() => log.close()); const base = await streamServer(t, log, { keepAliveMs: 60 });
  const s = sse(t, base); const ready = await s.wait((f) => f.event === 'foxfleet.ready');
  assert.match(s.frames[0].raw, /^retry: 2000/); assert.equal(ready.id, null);
  assert.deepEqual(ready.data, { contract: 'foxfleet.live/2', cursor: `${log.store}:0`, store: log.store, heartbeat_ms: 60 });
  log.emit('message.new', { agent: 'a', chat: 's', message: { hub_id: 'h', text: 'hello' } }); log.typing({ agent: 'a', chat: 's', state: 'typing', tool: null, ttl_ms: 6000 });
  const m = await s.wait((f) => f.event === 'message.new'); assert.equal(m.id, `${log.store}:1`); assert.equal(m.data.seq, 1); assert.equal(m.data.message.text, 'hello');
  const ty = await s.wait((f) => f.event === 'typing'); assert.equal(ty.id, null); assert.equal(ty.data.state, 'typing');
  await s.wait((f) => f.comment === ': keep-alive', 2000);
});

test('stream v2: resume replays only what was missed, across a restart, without duplicates; gap reasons are explicit', async (t) => {
  const file = await tmp(t); const a = await liveLog(file);
  for (let i = 1; i <= 3; i++) a.emit('chat.updated', { agent: 'a', i }); const store = a.store; await a.close();
  const log = await liveLog(file, { retainEvents: 5 }); t.after(() => log.close()); log.emit('chat.updated', { agent: 'a', i: 4 });
  const base = await streamServer(t, log);
  const r = sse(t, base, { 'Last-Event-ID': `${store}:2` }); const ready = await r.wait((f) => f.event === 'foxfleet.ready');
  assert.deepEqual(r.events().map((f) => f.data.i), [3, 4], 'replay after the restart'); assert.equal(ready.data.cursor, `${store}:4`); assert.ok(!r.frames.some((f) => f.event === 'foxfleet.gap'));
  const q = sse(t, `${base}?since=${store}:3`, { 'Last-Event-ID': `${store}:1` }); await q.wait((f) => f.event === 'foxfleet.ready'); assert.deepEqual(q.events().map((f) => f.data.i), [4], 'the query wins over the header');
  for (let i = 5; i <= 12; i++) log.emit('chat.updated', { agent: 'a', i });
  for (const [cursor, reason] of [[`${store}:1`, 'expired'], [`otherstore1:3`, 'reset'], [`${store}:999`, 'reset'], ['garbage!', 'invalid'], ['E1:3', 'reset']]) {
    const g = sse(t, `${base}?since=${encodeURIComponent(cursor)}`); const ready2 = await g.wait((f) => f.event === 'foxfleet.ready');
    const gap = g.frames.find((f) => f.event === 'foxfleet.gap'); assert.ok(gap, cursor); assert.deepEqual(gap.data, { reason, cursor: `${store}:12` }, cursor);
    assert.equal(g.events().length, 0, 'no partial replay after a gap'); assert.equal(ready2.data.cursor, `${store}:12`);
    assert.ok(g.frames.indexOf(gap) < g.frames.indexOf(ready2), 'gap comes before ready');
  }
  const fresh = sse(t, base); await fresh.wait((f) => f.event === 'foxfleet.ready'); assert.equal(fresh.events().length, 0, 'no cursor: starts at now');
  log.emit('chat.updated', { agent: 'a', i: 13 }); await fresh.wait((f) => f.data?.i === 13);
});

test('stream v2: 8 streams per account shared with v1 (429 too_many_streams); a signed-out device is told and closed', async (t) => {
  const log = await liveLog(await tmp(t)); t.after(() => log.close()); const bus = liveBus();
  const v2 = await streamServer(t, log, { counter: bus, keepAliveMs: 50 });
  const v1s = http.createServer((req, res) => { try { attachLiveStream(req, res, bus, {}); } catch (e) { res.writeHead(e.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: e.code })); } });
  const v1 = await listen(v1s); t.after(() => { v1s.closeAllConnections(); return new Promise((r) => v1s.close(r)); });
  const open = []; for (let i = 0; i < 8; i++) { const s = sse(t, i % 2 ? v1 : v2); await s.wait((f) => f.event === 'foxfleet.ready'); open.push(s); }
  for (const u of [v1, v2]) { const over = await fetch(u, { signal: AbortSignal.timeout(5000) }); assert.equal(over.status, 429); assert.equal((await over.json()).code, 'too_many_streams'); }
  open[0].stop(); for (let i = 0; i < 50 && bus.streams >= 8; i++) await sleep(20); assert.ok(bus.streams < 8);
  let ok = true; const log2 = await liveLog(await tmp(t)); t.after(() => log2.close()); const b2 = await streamServer(t, log2, { keepAliveMs: 40, alive: () => ok });
  const s = sse(t, b2); await s.wait((f) => f.event === 'foxfleet.ready'); ok = false;
  assert.equal((await s.wait((f) => f.event === 'foxfleet.auth', 2000)).data.reason, 'signed_out');
});
