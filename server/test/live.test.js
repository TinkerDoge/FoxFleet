// Live chat events (0.3.14): bus, resumable SSE stream with heartbeat and gap, and the hub wiring (a chat run started from one
// client reaches every other open client as run_started / run_finished at once). Every server and stream is closed in t.after.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub, HUB_FEATURES } from '../index.js';
import { liveBus, attachLiveStream, parseLiveCursor } from '../live.js';
import { mockHermes } from './fixtures.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(t, url, headers = {}) {
  const ac = new AbortController(), frames = [], ping = new Set(); let status = 0, failure = null;
  (async () => {
    const r = await fetch(url, { headers, signal: ac.signal }); status = r.status; const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2); const f = { raw, id: null, event: 'message', data: null, comment: raw.startsWith(':') ? raw : null };
        for (const line of raw.split('\n')) { if (line.startsWith('id: ')) f.id = line.slice(4); else if (line.startsWith('event: ')) f.event = line.slice(7); else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6)); }
        frames.push(f); for (const p of ping) p();
      }
    }
  })().catch((e) => { failure = e; for (const p of ping) p(); });
  t.after(() => ac.abort());
  const wait = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const check = () => { const f = frames.find(pred); if (f) { cleanup(); resolve(f); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out; status ${status}, error ${failure?.message}, got ${JSON.stringify(frames.map((x) => x.raw))}`)); }, ms);
    const cleanup = () => { clearTimeout(timer); ping.delete(check); };
    ping.add(check); check();
  });
  return { frames, wait, stop: () => ac.abort(), get status() { return status; }, lives: () => frames.filter((f) => f.event === 'live') };
}

async function busServer(t, bus, opts = {}) {
  const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); try { attachLiveStream(req, res, bus, { cursor: u.searchParams.get('after') ?? req.headers['last-event-id'] ?? '', ...opts }); } catch (e) { res.writeHead(e.status || 500); res.end(); } });
  const base = await listen(s); t.after(() => { s.closeAllConnections(); return new Promise((r) => s.close(r)); }); return base;
}

test('bus: typed events only, no text, bounded, ids increase', () => {
  const b = liveBus({ maxEvents: 3, epoch: 'e1' });
  assert.equal(b.emit({ type: 'nope', agent: 'a' }), null); assert.equal(b.emit({ type: 'run_started' }), null, 'agent required');
  const e = b.emit({ type: 'run_started', agent: 'a', chat: 's1', run_id: 'r1', text: 'secret reply' });
  assert.equal(e.id, 1); assert.equal(e.text, undefined, 'message text never travels on the bus'); assert.equal(e.chat, 's1');
  for (let i = 0; i < 4; i++) b.emit({ type: 'run_finished', agent: 'a', chat: 's1', state: 'done' });
  assert.deepEqual(b.since(0).events.map((x) => x.id), [3, 4, 5]); assert.equal(b.since(0).first, 3); assert.equal(b.cursor, 5);
  assert.equal(b.fromRunFinish({ agent: 'a', session: 's', id: 'r' }, 'error').state, 'error');
});

test('cursor: epoch:id, bare id, other epoch or future id is a gap, junk is fresh', () => {
  const b = liveBus({ epoch: 'ep' }); b.emit({ type: 'approval', agent: 'a' }); b.emit({ type: 'approval', agent: 'a' });
  assert.deepEqual(parseLiveCursor('ep:1', b), { after: 1, gap: false, fresh: false });
  assert.equal(parseLiveCursor('2', b).gap, true, 'a bare id cannot be checked against a restart');
  assert.equal(parseLiveCursor('old:1', b).gap, true, 'hub restarted'); assert.equal(parseLiveCursor('ep:9', b).gap, true, 'future id');
  for (const v of ['', 'x y', '-1', '1e3', undefined]) assert.equal(parseLiveCursor(v, b).fresh, true, String(v));
});

test('stream: ready, live push, heartbeat, resume by Last-Event-ID without duplicates, gap after restart', async (t) => {
  const b = liveBus({ epoch: 'E' }), base = await busServer(t, b, { keepAliveMs: 60 });
  const a = sse(t, base); const ready = await a.wait((f) => f.event === 'foxfleet.ready');
  assert.equal(ready.data.contract, 'foxfleet.live/1'); assert.equal(ready.data.cursor, 'E:0'); assert.equal(ready.id, null);
  assert.match(a.frames[0].raw, /^retry: 2000/);
  b.emit({ type: 'run_started', agent: 'atlas', chat: 's1', run_id: 'r1' });
  const got = await a.wait((f) => f.event === 'live'); assert.equal(got.id, 'E:1'); assert.equal(got.data.type, 'run_started'); assert.equal(got.data.chat, 's1');
  await a.wait((f) => f.comment === ': keep-alive', 2000);
  b.emit({ type: 'run_finished', agent: 'atlas', chat: 's1', state: 'done' }); b.emit({ type: 'approval', agent: 'atlas', chat: 's1' });
  const r = sse(t, base, { 'Last-Event-ID': 'E:1' }); await r.wait((f) => f.event === 'foxfleet.ready');
  assert.deepEqual(r.lives().map((f) => f.id), ['E:2', 'E:3'], 'replays only what was missed');
  const g = sse(t, base + '?after=OLD:7'); await g.wait((f) => f.event === 'foxfleet.ready');
  assert.ok(g.frames.some((f) => f.event === 'foxfleet.gap'), 'cursor from an earlier hub process: gap'); assert.equal(g.lives().length, 0);
  const fresh = sse(t, base); await fresh.wait((f) => f.event === 'foxfleet.ready'); assert.equal(fresh.lives().length, 0, 'a fresh client starts at now');
});

test('stream: a cursor from an empty bus (epoch:0) that fell behind the buffer gets a gap; a bare id after a restart is a gap', async (t) => {
  const b = liveBus({ epoch: 'Z', maxEvents: 5 }), base = await busServer(t, b);
  for (let i = 0; i < 10; i++) b.emit({ type: 'run_finished', agent: 'a', chat: 's', state: 'done' });
  const s = sse(t, base, { 'Last-Event-ID': 'Z:0' }); await s.wait((f) => f.event === 'foxfleet.ready');
  assert.ok(s.frames.some((f) => f.event === 'foxfleet.gap'), 'gap marker, not a silent partial replay'); assert.equal(s.lives().length, 0);
  const ok = sse(t, base, { 'Last-Event-ID': 'Z:6' }); await ok.wait((f) => f.event === 'foxfleet.ready');
  assert.ok(!ok.frames.some((f) => f.event === 'foxfleet.gap')); assert.deepEqual(ok.lives().map((f) => f.id), ['Z:7', 'Z:8', 'Z:9', 'Z:10']);
  const bare = sse(t, base, { 'Last-Event-ID': '2' }); await bare.wait((f) => f.event === 'foxfleet.ready');
  assert.ok(bare.frames.some((f) => f.event === 'foxfleet.gap')); assert.equal(bare.lives().length, 0);
});

test('stream: too many streams is 429, a closed stream frees its slot, signed-out device is told', async (t) => {
  const b = liveBus(); const base = await busServer(t, b, { keepAliveMs: 50 });
  const open = []; for (let i = 0; i < 8; i++) { const s = sse(t, base); await s.wait((f) => f.event === 'foxfleet.ready'); open.push(s); }
  const over = await fetch(base, { signal: AbortSignal.timeout(5000) }); assert.equal(over.status, 429); await over.body?.cancel();
  open[0].stop(); for (let i = 0; i < 50 && b.streams >= 8; i++) await sleep(20); assert.ok(b.streams < 8);
  let ok = true; const b2 = liveBus(); const base2 = await busServer(t, b2, { keepAliveMs: 40, alive: () => ok });
  const s = sse(t, base2); await s.wait((f) => f.event === 'foxfleet.ready'); ok = false;
  const auth = await s.wait((f) => f.event === 'foxfleet.auth', 2000); assert.equal(auth.data.reason, 'signed_out');
});

test('hub: a chat run from one client reaches another open client live (run_started, run_finished) and the feature is advertised', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-live-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  let release; const gate = new Promise((r) => { release = r; });
  const up = await mockHermes(t, { apiRoute: async (req, res, route) => {
    if (route !== '/v1/chat/completions') return false;
    req.resume(); await new Promise((r) => req.on('end', r));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': 'sess-live' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'); await gate; res.end('data: [DONE]\n\n'); return true;
  } });
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true }); const base = await listen(server);
  t.after(() => { release(); server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  const call = async (p, data) => { const r = await fetch(base + p, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; };
  assert.ok(HUB_FEATURES.includes('live')); assert.ok((await call('/api/auth')).body.hub.features.includes('live'));
  assert.equal((await call('/api/connections', { ...up.connection, name: 'atlas' })).status, 201);
  const phone = sse(t, `${base}/api/live/stream`); await phone.wait((f) => f.event === 'foxfleet.ready');
  const ac = new AbortController(); t.after(() => ac.abort());
  const web = fetch(`${base}/api/agents/atlas/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hello' }] }), signal: ac.signal });
  const started = await phone.wait((f) => f.event === 'live' && f.data.type === 'run_started');
  assert.equal(started.data.agent, 'atlas'); assert.equal(started.data.chat, 'sess-live'); assert.ok(started.data.run_id);
  release(); const resp = await web; await resp.text().catch(() => {});
  const fin = await phone.wait((f) => f.event === 'live' && f.data.type === 'run_finished'); assert.equal(fin.data.state, 'done'); assert.equal(fin.data.run_id, started.data.run_id);
  const resumed = sse(t, `${base}/api/live/stream`, { 'Last-Event-ID': started.id }); await resumed.wait((f) => f.event === 'foxfleet.ready');
  assert.deepEqual(resumed.lives().map((f) => f.data.type), ['run_finished'], 'catch-up after a drop replays the missed finish');
});

test('hub: live stream needs a login', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-live-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: false, ownerPassword: 'correct horse battery staple' }); const base = await listen(server);
  t.after(() => { server.closeAllConnections(); return new Promise((r) => server.close(r)); });
  const r = await fetch(`${base}/api/live/stream`, { signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 401); await r.body?.cancel();
});
