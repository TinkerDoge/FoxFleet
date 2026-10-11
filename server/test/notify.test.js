// Notifications phase 1: event log (bounded, persistent), per-agent / per-chat mute, resumable SSE stream with heartbeat,
// and the three event sources (reply finished, error, approval). Every server, stream and timer is closed in t.after; every wait has a hard timeout.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../index.js';
import { notifyStore, attachNotifyStream } from '../notify.js';
import { validate } from '../../contract/validate.mjs';
import { spec } from '../../contract/run.mjs';
import { setup as setupNative } from './ui-helpers.js';
import { waitFor } from './machine-helpers.js';

const open = new WeakMap(); // per test: stores opened here are closed (pending saves cancelled) before the temp dir goes, whatever order the hooks run in
const openStore = async (t, file, o) => { const st = await notifyStore(file, o); (open.get(t) ?? open.set(t, []).get(t)).push(st); return st; };
const tmp = async (t) => { const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-notify-')); t.after(async () => { for (const st of open.get(t) ?? []) await st.close(); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); }); return dir; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

async function hub(t, opts = {}) {
  const dir = await tmp(t), server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  (open.get(t) ?? open.set(t, []).get(t)).push({ close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); } }); // before the temp dir is removed: close flushes the notify store
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, data, method = data === undefined ? 'GET' : 'POST') => { const r = await fetch(base + p, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  return { dir, base, call, server };
}

// SSE client: parses frames, `wait(pred)` has a hard timeout, aborted in t.after.
function sse(t, url, headers = {}) {
  const ac = new AbortController(), frames = [], ping = new Set(); let status = 0, failure = null;
  const done = (async () => {
    const r = await fetch(url, { headers, signal: ac.signal }); status = r.status; const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2); const f = { raw, id: null, event: 'message', data: null, comment: raw.startsWith(':') ? raw : null };
        for (const line of raw.split('\n')) { if (line.startsWith('id: ')) f.id = Number(line.slice(4)); else if (line.startsWith('event: ')) f.event = line.slice(7); else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6)); }
        frames.push(f); for (const p of ping) p();
      }
    }
  })().catch((e) => { failure = e; for (const p of ping) p(); });
  t.after(() => ac.abort());
  const wait = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const check = () => { const f = frames.find(pred); if (f) { cleanup(); resolve(f); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for a frame; status ${status}, error ${failure?.cause?.message ?? failure?.message}, got ${JSON.stringify(frames.map((x) => x.raw))}`)); }, ms);
    const cleanup = () => { clearTimeout(timer); ping.delete(check); };
    ping.add(check); check();
  });
  return { frames, wait, stop: () => ac.abort(), done, get status() { return status; }, notifies: () => frames.filter((f) => f.event === 'notify') };
}

test('store: bounded log, ids never go back, persists across a restart', async (t) => {
  const dir = await tmp(t), file = path.join(dir, 'notify.json');
  let a = await openStore(t, file, { maxEvents: 5 });
  for (let i = 0; i < 8; i++) a.emit({ type: 'reply_finished', agent: 'a', chat: `c${i}` });
  const { events, first, cursor } = a.since(0); assert.equal(events.length, 5); assert.equal(first, 4); assert.equal(cursor, 8); assert.deepEqual(events.map((e) => e.id), [4, 5, 6, 7, 8]);
  await a.setMute({ agent: 'a', muted: true }); await a.flush();
  assert.equal((await readFile(file, 'utf8')).includes('"seq":8'), true);
  const b = await openStore(t, file, { maxEvents: 5 }); assert.equal(b.cursor, 8); assert.deepEqual(b.since(6).events.map((e) => e.id), [7, 8]); assert.equal(b.prefs().agents[0].agent, 'a', 'mute survives a restart');
  assert.equal(b.emit({ type: 'error', agent: 'a' }).id, 9, 'the next id continues after a restart');
  assert.equal(b.fromRun({ agent: 'a', session: 's', id: 'r' }, 'stopped'), null, 'a run the user stopped is not a notification'); assert.equal(b.fromRun({ agent: 'a', session: 's', id: 'r' }, 'done').type, 'reply_finished'); assert.equal(b.fromRun({ agent: 'a', session: 's', id: 'r' }, 'error').type, 'error');
  assert.throws(() => b.emit({ type: 'nope' }), /unknown notification type/);
  await b.flush(); await writeBroken(file); assert.equal((await openStore(t, file)).cursor, 0, 'an unreadable file starts empty instead of crashing the hub');
});
async function writeBroken(file) { await (await import('node:fs/promises')).writeFile(file, '{not json'); }

test('store: mute rules (agent, chat, approval ignores a chat mute, expiry, master switch, validation)', async (t) => {
  let clock = 1_000_000; const s = await openStore(t, path.join(await tmp(t), 'n.json'), { now: () => clock });
  assert.equal(s.emit({ type: 'reply_finished', agent: 'a', chat: 'c1' }).muted, false);
  await s.setMute({ agent: 'a', chat: 'c1', muted: true });
  assert.equal(s.emit({ type: 'reply_finished', agent: 'a', chat: 'c1' }).muted, true, 'chat mute');
  assert.equal(s.emit({ type: 'reply_finished', agent: 'a', chat: 'c2' }).muted, false, 'other chats are not muted');
  assert.equal(s.emit({ type: 'error', agent: 'a', chat: 'c1' }).muted, true);
  assert.equal(s.emit({ type: 'approval', agent: 'a', chat: 'c1', request_id: 'r1' }).muted, false, 'an approval breaks through a chat mute');
  await s.setMute({ agent: 'a', muted: true, forMs: 60_000 });
  assert.equal(s.emit({ type: 'approval', agent: 'a', chat: 'c2', request_id: 'r2' }).muted, true, 'but not an agent mute');
  assert.equal(s.emit({ type: 'reply_finished', agent: 'b', chat: 'c1' }).muted, false, 'other agents are not muted');
  clock += 60_001; assert.equal(s.emit({ type: 'reply_finished', agent: 'a', chat: 'c2' }).muted, false, 'a timed mute expires');
  assert.deepEqual(s.prefs().agents, []); assert.equal(s.prefs().chats.length, 1);
  await s.setMute({ agent: 'a', chat: 'c1', muted: false }); assert.deepEqual(s.prefs().chats, []);
  await s.setEnabled(false); assert.equal(s.emit({ type: 'approval', agent: 'a', chat: 'c1' }).muted, true, 'master switch off mutes everything'); assert.equal(s.emit({ type: 'test' }).muted, true);
  await s.setEnabled(true); assert.equal(s.emit({ type: 'test' }).muted, false);
  await assert.rejects(s.setMute({ agent: '', muted: true }), { status: 400 }); await assert.rejects(s.setMute({ agent: 'a', muted: 'yes' }), { status: 400 });
  await assert.rejects(s.setMute({ agent: 'a', muted: true, forMs: 5 }), { status: 400 }); await assert.rejects(s.setMute({ agent: 'a', chat: 'x\ny', muted: true }), { status: 400 }); await assert.rejects(s.setEnabled('no'), { status: 400 });
});

test('API: auth is required, mute/prefs validate, events list carries muted events', async (t) => {
  const x = await hub(t), loginHub = await hub(t, { singleUser: false, ownerPassword: 'correct horse battery staple' });
  for (const [m, p] of [['GET', '/api/notify/stream'], ['GET', '/api/notify/events'], ['GET', '/api/notify/prefs'], ['PUT', '/api/notify/mute'], ['POST', '/api/notify/test']]) {
    const r = await fetch(loginHub.base + p, { method: m, headers: m === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}', signal: AbortSignal.timeout(10_000) }); assert.equal(r.status, 401, `${m} ${p} without a login`); await r.body?.cancel();
  }
  assert.ok((await x.call('/api/auth')).body.hub.features.includes('notify'), 'advertised in hub.features');
  assert.deepEqual((await x.call('/api/notify/prefs')).body, { enabled: true, storage: { ok: true }, dropped: 0, agents: [], chats: [] });
  assert.equal((await x.call('/api/notify/mute', { agent: 'ghost', muted: true }, 'PUT')).status, 404, 'unknown agent');
  assert.equal((await x.call('/api/notify/prefs', { enabled: 'x' }, 'PUT')).status, 400);
  assert.equal((await x.call('/api/notify/nope')).status, 404);
  const off = (await x.call('/api/notify/prefs', { enabled: false }, 'PUT')).body; assert.equal(off.enabled, false);
  const test1 = (await x.call('/api/notify/test', {})).body.event; assert.equal(test1.muted, true); assert.equal(test1.type, 'test');
  await x.call('/api/notify/prefs', { enabled: true }, 'PUT'); const test2 = (await x.call('/api/notify/test', {})).body.event; assert.equal(test2.muted, false); assert.equal(test2.id, test1.id + 1);
  const list = (await x.call('/api/notify/events?since=0')).body; assert.deepEqual(list.events.map((e) => e.id), [test1.id, test2.id]); assert.equal(list.events[0].muted, true); assert.equal(list.cursor, test2.id);
  assert.deepEqual((await x.call(`/api/notify/events?since=${test1.id}`)).body.events.map((e) => e.id), [test2.id]);
});

test('stream: ready, live delivery, resume by Last-Event-ID and ?after, gap notices, no duplicates', async (t) => {
  const x = await hub(t), A = `${x.base}/api/notify/stream`;
  const a = sse(t, A); const ready = await a.wait((f) => f.event === 'foxfleet.ready'); assert.equal(ready.data.contract, 'foxfleet.notify/1'); assert.equal(ready.data.cursor, 0); assert.equal(ready.id, null, 'ready carries no id so it cannot move Last-Event-ID');
  assert.equal(a.status, 200); assert.match(a.frames[0].raw, /^retry: 3000/);
  const ev1 = (await x.call('/api/notify/test', {})).body.event, got = await a.wait((f) => f.event === 'notify'); assert.equal(got.id, ev1.id); assert.deepEqual(got.data, ev1);
  await x.call('/api/notify/test', {}); await x.call('/api/notify/test', {}); await a.wait((f) => f.id === 3); a.stop();
  const b = sse(t, A, { 'Last-Event-ID': '1' }); await b.wait((f) => f.event === 'foxfleet.ready'); assert.deepEqual(b.notifies().map((f) => f.id), [2, 3], 'resume replays exactly what was missed');
  await x.call('/api/notify/test', {}); await b.wait((f) => f.id === 4); assert.deepEqual(b.notifies().map((f) => f.id), [2, 3, 4], 'live events follow the replay without duplicates'); b.stop();
  const c = sse(t, `${A}?after=3`); await c.wait((f) => f.event === 'foxfleet.ready'); assert.deepEqual(c.notifies().map((f) => f.id), [4], '?after works like Last-Event-ID');
  const d = sse(t, A, { 'Last-Event-ID': '99' }); const gap = await d.wait((f) => f.event === 'foxfleet.gap'); assert.deepEqual(gap.data, { first: 1, cursor: 4 }, 'a cursor from the future is told to restart'); assert.equal(d.notifies().length, 0);
  const e = sse(t, A, { 'Last-Event-ID': 'garbage' }); await e.wait((f) => f.event === 'foxfleet.ready'); assert.deepEqual(e.notifies().map((f) => f.id), [1, 2, 3, 4], 'a bad cursor means from the start of the log');
});

test('stream: a log trimmed past the client cursor reports a gap', async (t) => {
  const dir = await tmp(t), file = path.join(dir, 'config.json');
  const pre = await openStore(t, path.join(dir, 'notify.json'), { maxEvents: 500 }); for (let i = 0; i < 503; i++) pre.emit({ type: 'test' }); await pre.flush(); // 3 oldest dropped
  const server = await createHub({ configPath: file, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const s = sse(t, `http://127.0.0.1:${server.address().port}/api/notify/stream`, { 'Last-Event-ID': '1' });
  const gap = await s.wait((f) => f.event === 'foxfleet.gap'); assert.deepEqual(gap.data, { first: 4, cursor: 503 }); await s.wait((f) => f.event === 'foxfleet.ready'); assert.equal(s.notifies().length, 500); assert.equal(s.notifies()[0].id, 4);
});

test('stream: heartbeat comments keep coming while idle (comments, not events)', async (t) => {
  const prev = process.env.FOXFLEET_NOTIFY_HEARTBEAT_MS; process.env.FOXFLEET_NOTIFY_HEARTBEAT_MS = '40'; t.after(() => { if (prev === undefined) delete process.env.FOXFLEET_NOTIFY_HEARTBEAT_MS; else process.env.FOXFLEET_NOTIFY_HEARTBEAT_MS = prev; });
  const x = await hub(t), s = sse(t, `${x.base}/api/notify/stream`);
  await s.wait((f) => f.comment === ': keep-alive'); await s.wait(() => s.frames.filter((f) => f.comment).length >= 3); assert.ok(s.notifies().length === 0, 'heartbeats are comments, not events');
  s.stop(); await s.done;
});

test('stream: muted events are logged but not pushed; cursor still advances; approval passes a chat mute', async (t) => {
  const x = await hub(t), api = http.createServer((req, res) => { req.resume(); req.on('end', () => { if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); } res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'); }); });
  const upstream = await listen(api); t.after(() => { api.closeAllConnections(); api.close(); });
  assert.equal((await x.call('/api/connections', { name: 'glm', kind: 'openai', baseUrl: upstream + '/v1', model: 'm', apiKey: 'k' })).status, 201);
  assert.equal((await x.call('/api/notify/mute', { agent: 'glm', chat: 'h_mutedchat', muted: true }, 'PUT')).status, 200);
  assert.deepEqual((await x.call('/api/notify/prefs')).body.chats, [{ agent: 'glm', chat: 'h_mutedchat', until: null }]);
  const s = sse(t, `${x.base}/api/notify/stream`); await s.wait((f) => f.event === 'foxfleet.ready');
  const ask = async (session) => { const r = await fetch(`${x.base}/api/agents/glm/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], session_id: session }), signal: AbortSignal.timeout(10_000) }); await r.text(); };
  await ask('h_mutedchat'); const logged = await waitFor(async () => { const l = (await x.call('/api/notify/events')).body.events; return l.length ? l : null; }, { tries: 100, ms: 50 });
  assert.equal(logged[0].muted, true); assert.equal(logged[0].chat, 'h_mutedchat'); assert.equal(s.notifies().length, 0, 'a muted chat is not pushed');
  await ask('h_otherchat'); const pushed = await s.wait((f) => f.event === 'notify'); assert.equal(pushed.data.chat, 'h_otherchat'); assert.equal(pushed.id, 2, 'the muted event used id 1: ids are continuous');
  assert.equal((await x.call('/api/notify/mute', { agent: 'glm', muted: true }, 'PUT')).status, 200); await ask('h_otherchat'); await waitFor(async () => ((await x.call('/api/notify/events')).body.events.length >= 3 ? true : null), { tries: 100, ms: 50 });
  assert.equal(s.notifies().length, 1, 'an agent mute stops pushes too'); assert.equal((await x.call('/api/notify/events')).body.events[2].muted, true);
});

test('events: reply_finished and error come from finished chat runs (never message text)', async (t) => {
  const x = await hub(t); let mode = 'ok';
  const api = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (mode === 'ok') return void res.end('data: {"choices":[{"delta":{"content":"SECRET-REPLY-TEXT"}}]}\n\ndata: [DONE]\n\n');
    res.write('data: {"choices":[{"delta":{"content":"partial SECRET-REPLY-TEXT"}}]}\n\n'); setTimeout(() => res.destroy(), 30); }); });
  const upstream = await listen(api); t.after(() => { api.closeAllConnections(); api.close(); });
  assert.equal((await x.call('/api/connections', { name: 'glm', kind: 'openai', baseUrl: upstream + '/v1', model: 'm', apiKey: 'k' })).status, 201);
  const s = sse(t, `${x.base}/api/notify/stream`); await s.wait((f) => f.event === 'foxfleet.ready');
  const ask = async () => { const r = await fetch(`${x.base}/api/agents/glm/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(10_000) }); const sid = r.headers.get('x-hermes-session-id'); await r.text().catch(() => ''); return sid; };
  const sid = await ask(); const done = await s.wait((f) => f.data?.type === 'reply_finished');
  assert.equal(done.data.agent, 'glm'); assert.equal(done.data.chat, sid); assert.equal(done.data.priority, 'normal'); assert.equal(done.data.v, 1); assert.match(done.data.run_id, /\S/);
  mode = 'break'; const sid2 = await ask(); const err = await s.wait((f) => f.data?.type === 'error');
  assert.equal(err.data.agent, 'glm'); assert.equal(err.data.chat, sid2); assert.equal(err.data.priority, 'high'); assert.equal(err.data.message, 'The agent turn failed');
  assert.ok(!JSON.stringify(s.frames.map((f) => f.raw)).includes('SECRET-REPLY-TEXT'), 'no reply text in notifications');
  assert.ok(!JSON.stringify((await x.call('/api/notify/events')).body).includes('SECRET-REPLY-TEXT'));
});

test('events: an approval / question of a native Hermes session becomes an approval notification (and a chat mute does not hide it)', async (t) => {
  const x = await setupNative(t), json = async (route, data, method) => { const r = await fetch(x.base + route, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await waitFor(async () => { const a = (await json('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  const A = '/api/agents/default/native', sid = (await json(`${A}/sessions`, {})).body.session_id;
  assert.equal((await json('/api/notify/mute', { agent: 'default', chat: sid, muted: true }, 'PUT')).status, 200);
  const s = sse(t, `${x.base}/api/notify/stream`); await s.wait((f) => f.event === 'foxfleet.ready');
  assert.equal((await json(`${A}/sessions/${sid}/messages`, { text: 'please clarify env' })).status, 202);
  const ap = await s.wait((f) => f.data?.type === 'approval', 15_000);
  assert.equal(ap.data.agent, 'default'); assert.equal(ap.data.chat, sid); assert.equal(ap.data.priority, 'high'); assert.equal(ap.data.kind, 'clarify'); assert.match(ap.data.request_id, /^srq-/); assert.equal(ap.data.muted, false, 'approvals ignore a chat mute');
  assert.ok(!JSON.stringify(ap.data).includes('Which environment'), 'the question text is not in the notification');
});

// ---- review fixes (P1-P8) ----
const PASS = 'correct horse battery staple';
async function accountsHub(t) {
  const x = await hub(t, { singleUser: false, ownerPassword: PASS });
  const login = async () => { const r = await fetch(x.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASS, client: 'app' }), signal: AbortSignal.timeout(10_000) }); const b = await r.json(); assert.equal(r.status, 200); return { token: b.token, device: b.deviceId, h: { Authorization: `Bearer ${b.token}` } }; };
  return { ...x, login };
}

test('P1: revoking a device closes its open streams at once (final foxfleet.auth frame); other devices keep theirs; logout-all closes the rest', async (t) => {
  const x = await accountsHub(t), a = await x.login(), b = await x.login();
  const sa = sse(t, `${x.base}/api/notify/stream`, a.h), sb = sse(t, `${x.base}/api/notify/stream`, b.h);
  await sa.wait((f) => f.event === 'foxfleet.ready'); await sb.wait((f) => f.event === 'foxfleet.ready');
  const del = await fetch(`${x.base}/api/auth/devices/${a.device}`, { method: 'DELETE', headers: b.h, signal: AbortSignal.timeout(10_000) }); assert.equal(del.status, 200); await del.body?.cancel();
  const bye = await sa.wait((f) => f.event === 'foxfleet.auth'); assert.deepEqual(bye.data, { reason: 'signed_out' }); await Promise.race([sa.done, sleep(3000).then(() => { throw new Error('revoked stream was not closed'); })]);
  const ev = await fetch(`${x.base}/api/notify/test`, { method: 'POST', headers: { ...b.h, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }); assert.equal(ev.status, 200); await ev.body?.cancel();
  await sb.wait((f) => f.event === 'notify'); assert.equal(sa.notifies().length, 0, 'nothing reached the revoked device');
  assert.equal((await fetch(`${x.base}/api/notify/stream`, { headers: a.h, signal: AbortSignal.timeout(10_000) })).status, 401, 'and it cannot reconnect');
  const out = await fetch(`${x.base}/api/auth/logout-all`, { method: 'POST', headers: { ...b.h, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }); assert.equal(out.status, 200); await out.body?.cancel();
  await sb.wait((f) => f.event === 'foxfleet.auth'); await Promise.race([sb.done, sleep(3000).then(() => { throw new Error('logout-all did not close the stream'); })]);
});

test('P1/P6: heartbeat re-checks the session (expiry backstop) and the rotated X-Session-Token header reaches the stream response', async (t) => {
  const store = await openStore(t, path.join(await tmp(t), 'n.json')); let valid = true;
  const server = http.createServer((req, res) => { res.setHeader('X-Session-Token', 'rotated-token-value'); attachNotifyStream(req, res, store, { keepAliveMs: 30, alive: () => valid }); });
  const base = await listen(server); t.after(() => { server.closeAllConnections(); server.close(); });
  const ac = new AbortController(); t.after(() => ac.abort()); const r = await fetch(base, { signal: ac.signal });
  assert.equal(r.headers.get('x-session-token'), 'rotated-token-value', 'a rotated token set before the stream starts is on the stream response');
  const dec = new TextDecoder(); let text = ''; const reader = r.body.getReader(); valid = true;
  const readUntil = async (re) => { const stop = Date.now() + 5000; while (!re.test(text)) { if (Date.now() > stop) throw new Error('timeout: ' + text); const { value, done } = await Promise.race([reader.read(), sleep(1000).then(() => ({ value: undefined, done: false }))]); if (value) text += dec.decode(value); if (done) break; } };
  await readUntil(/: keep-alive/); valid = false; await readUntil(/foxfleet\.auth/); assert.match(text, /"reason":"signed_out"/);
  await Promise.race([readUntil(/never/).catch(() => {}), sleep(100)]); assert.equal(store.streams, 0, 'the subscription was released');
});

test('P2: a burst of events is coalesced into very few writes and little memory; the file is complete after flush', async (t) => {
  const file = path.join(await tmp(t), 'n.json'), s = await openStore(t, file, { saveMs: 50 }); const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 4000; i++) s.emit({ type: 'test' });
  await s.flush(); assert.ok(s.writes <= 3, `4000 events caused ${s.writes} writes`); assert.ok(process.memoryUsage().heapUsed - before < 80e6, 'no snapshot per event queued in memory');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).seq, 4000); assert.equal((await openStore(t, file)).cursor, 4000);
  await s.setMute({ agent: 'a', muted: true }); assert.ok(s.writes <= 4, 'a mute change is written at once'); assert.equal(JSON.parse(await readFile(file, 'utf8')).prefs.agents.a.until, null);
});

test('P3: a failing disk is reported (health, prefs.storage, one log line per minute), never thrown, and recovers', async (t) => {
  const dir = await tmp(t), file = path.join(dir, 'missing', 'n.json'); let clock = 5_000_000;
  const log = mock.method(console, 'error', () => {}); t.after(() => log.mock.restore());
  const s = await openStore(t, file, { saveMs: 10, now: () => clock });
  s.emit({ type: 'test' }); await s.flush(); assert.equal(s.health.ok, false); assert.equal(s.health.error, 'ENOENT'); assert.deepEqual(s.prefs().storage, { ok: false, error: 'ENOENT' });
  s.emit({ type: 'test' }); await s.flush(); assert.equal(log.mock.callCount(), 1, 'logged once, not per failed write'); assert.match(log.mock.calls[0].arguments[0], /notify\.save_failed/); assert.ok(!log.mock.calls[0].arguments[0].includes(dir), 'no path in the log');
  clock += 61_000; s.emit({ type: 'test' }); await s.flush(); assert.equal(log.mock.callCount(), 2, 'and again after a minute');
  await mkdir(path.dirname(file)); s.emit({ type: 'test' }); await s.flush(); assert.equal(s.health.ok, true); assert.deepEqual(s.prefs().storage, { ok: true }); assert.equal(JSON.parse(await readFile(file, 'utf8')).seq, 4, 'recovered with the full state');
  const seen = []; const s2 = await openStore(t, file, { saveMs: 10, onError: (e) => seen.push(e.code) }); await rm(path.dirname(file), { recursive: true }); s2.emit({ type: 'test' }); await s2.flush(); assert.deepEqual(seen, ['ENOENT'], 'onError hook gets it');
});

test('P4: limit 0, negatives and junk mean the default; the max is 500; since is strict; gap flag on the list', async (t) => {
  const s = await openStore(t, path.join(await tmp(t), 'n.json'), { maxEvents: 150, saveMs: 10_000 });
  for (let i = 0; i < 200; i++) s.emit({ type: 'test' });
  assert.equal(s.since(0, 0).events.length, 100); assert.equal(s.since(0, -3).events.length, 100); assert.equal(s.since(0, NaN).events.length, 100); assert.equal(s.since(0, 10).events.length, 10); assert.equal(s.since(0, 99999).events.length, 150);
  assert.equal(s.since(0).gap, false, 'no cursor yet: nothing was missed'); assert.equal(s.since(51).first, 51); assert.equal(s.since(51).gap, false, 'since+1 == first: nothing lost'); assert.equal(s.since(50).gap, false);
  assert.equal(s.since(49).gap, true, 'since+1 < first: events 50 is gone'); assert.equal(s.since(500).gap, true, 'a cursor from the future'); assert.equal(s.since(200).gap, false);
  const x = await hub(t); for (const q of ['since=abc', 'since=1e3', 'since=-5', 'since=0x10', 'since=']) assert.equal((await x.call(`/api/notify/events?${q}`)).status, 400, q);
  await x.call('/api/notify/test', {}); assert.equal((await x.call('/api/notify/events?limit=0')).body.events.length, 1); assert.equal((await x.call('/api/notify/events?limit=-3')).body.events.length, 1); assert.equal((await x.call('/api/notify/events?limit=abc')).body.events.length, 1);
  assert.equal((await x.call('/api/notify/events')).body.gap, false);
  const st = sse(t, `${x.base}/api/notify/stream?after=0x10`); await st.wait((f) => f.event === 'foxfleet.gap' || f.event === 'foxfleet.ready'); assert.equal(st.notifies().length, 1, 'a non-decimal stream cursor is treated as no cursor');
});

test('P5: bursts of replies/errors cannot flush the log; approvals and test are exempt from it; /test is limited per minute', async (t) => {
  let clock = 9_000_000; const s = await openStore(t, path.join(await tmp(t), 'n.json'), { now: () => clock, eventsPerMin: 5, testsPerMin: 3, saveMs: 10_000 });
  const made = []; for (let i = 0; i < 20; i++) made.push(s.emit({ type: i % 2 ? 'error' : 'reply_finished', agent: 'a', chat: 'c' }));
  assert.equal(made.filter(Boolean).length, 5); assert.equal(s.dropped, 15); assert.equal(s.since(0).events.length, 5);
  assert.ok(s.emit({ type: 'approval', agent: 'a', chat: 'c', request_id: 'r' }), 'an approval is never dropped'); assert.ok(s.emit({ type: 'test' }));
  assert.equal(s.fromRun({ agent: 'a', session: 'c', id: 'r' }, 'done'), null, 'fromRun reports a drop as null');
  clock += 60_001; assert.ok(s.emit({ type: 'reply_finished', agent: 'a', chat: 'c' }), 'the window slides');
  assert.deepEqual([s.allowTest(), s.allowTest(), s.allowTest(), s.allowTest()], [true, true, true, false]); clock += 60_001; assert.equal(s.allowTest(), true);
  const x = await hub(t); const codes = []; let last; for (let i = 0; i < 12; i++) { const r = await fetch(x.base + '/api/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }); codes.push(r.status); last = r; await r.body?.cancel(); }
  assert.deepEqual(codes, [...Array(10).fill(200), 429, 429]); assert.equal(last.headers.get('retry-after'), '60');
});

test('P8: every /api/notify route is in contract/openapi.json and the real responses match the schemas', async (t) => {
  const want = { '/api/notify/stream': ['get'], '/api/notify/events': ['get'], '/api/notify/prefs': ['get', 'put'], '/api/notify/mute': ['put'], '/api/notify/test': ['post'] };
  for (const [p, methods] of Object.entries(want)) for (const m of methods) { const op = spec.paths[p]?.[m]; assert.ok(op?.operationId, `${m} ${p} in the spec`); assert.ok(op.responses['401'], `${m} ${p} documents 401`); }
  const x = await hub(t), check = (p, m, status, body) => { const decl = spec.paths[p][m].responses[String(status)]; assert.ok(decl, `${m} ${p} ${status} declared`); const schema = decl.content?.['application/json']?.schema ?? spec.components.responses.Error.content['application/json'].schema; assert.deepEqual(validate(schema, body, spec), [], `${m} ${p} ${status}`); };
  assert.equal((await x.call('/api/connections', { name: 'glm', kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' })).status, 201);
  let r = await x.call('/api/notify/prefs'); check('/api/notify/prefs', 'get', 200, r.body);
  r = await x.call('/api/notify/prefs', { enabled: true }, 'PUT'); check('/api/notify/prefs', 'put', 200, r.body); r = await x.call('/api/notify/prefs', { enabled: 'x' }, 'PUT'); check('/api/notify/prefs', 'put', 400, r.body);
  r = await x.call('/api/notify/mute', { agent: 'glm', chat: 'h_c1', muted: true, for_ms: 60000 }, 'PUT'); check('/api/notify/mute', 'put', 200, r.body); assert.equal(r.body.chats.length, 1);
  r = await x.call('/api/notify/mute', { agent: 'ghost', muted: true }, 'PUT'); check('/api/notify/mute', 'put', 404, r.body);
  r = await x.call('/api/notify/test', {}); check('/api/notify/test', 'post', 200, r.body); r = await x.call('/api/notify/events'); check('/api/notify/events', 'get', 200, r.body);
  r = await x.call('/api/notify/events?since=abc'); check('/api/notify/events', 'get', 400, r.body);
  for (let i = 0; i < 10; i++) r = await x.call('/api/notify/test', {}); check('/api/notify/test', 'post', 429, r.body);
});

// ---- recheck fixes ----
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// A REAL hub process (server/index.js): it logs in, creates events, gets a signal at once, and the events must be on disk after it exits.
async function spawnHub(t, dir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...process.env, FOXFLEET_CONFIG: path.join(dir, 'config.json'), FOXFLEET_PORT: String(port), FOXFLEET_HOST: '127.0.0.1', FOXFLEET_PASSWORD: PASS }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', exited = null; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((r) => child.once('exit', (code, sig) => { exited = { code, sig }; r(exited); }));
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await Promise.race([exit, sleep(5000)]); } }); // never leave a child behind
  assert.ok(await waitFor(async () => (/Foxfleet listening/.test(out) ? true : exited ? Promise.reject(new Error('hub exited early: ' + out)) : null), { tries: 100, ms: 100 }), 'the hub did not start: ' + out);
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASS, client: 'app' }), signal: AbortSignal.timeout(10_000) }); const token = (await r.json()).token; assert.ok(token);
  const ev = async () => { const x = await fetch(base + '/api/notify/test', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }); assert.equal(x.status, 200); return (await x.json()).event.id; };
  return { child, exit, ev, out: () => out };
}

for (const signal of ['SIGTERM', 'SIGINT']) test(`a clean ${signal} writes the last events (the debounced save is flushed) in a real hub process`, async (t) => {
  const dir = await tmp(t), port = await freePort();
  const h = await spawnHub(t, dir, port); const ids = []; for (let i = 0; i < 3; i++) ids.push(await h.ev());
  h.child.kill(signal); // right after the last event: well inside the 250 ms debounce
  const res = await Promise.race([h.exit, sleep(15_000).then(() => { throw new Error('the hub did not exit after ' + signal + ': ' + h.out()); })]); assert.equal(res.code, 0, `clean exit, got ${JSON.stringify(res)}`);
  const onDisk = JSON.parse(await readFile(path.join(dir, 'notify.json'), 'utf8')); assert.deepEqual(onDisk.events.map((e) => e.id), ids, 'every event made it to disk'); assert.equal(onDisk.seq, ids.at(-1));
  // and the next process continues from there (same data dir), then gets the other signal's treatment on a second life
  const h2 = await spawnHub(t, dir, await freePort()); const next = await h2.ev(); assert.equal(next, ids.at(-1) + 1, 'ids continue after the restart'); h2.child.kill(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM');
  assert.equal((await Promise.race([h2.exit, sleep(15_000).then(() => { throw new Error('second hub did not exit'); })])).code, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'notify.json'), 'utf8')).events.map((e) => e.id), [...ids, next]);
  assert.ok(!/save_failed/.test(h.out() + h2.out()), 'no write errors on shutdown');
});

test('a closed hub has written its pending events (server.close flushes), so a temp dir can go right after', async (t) => {
  const dir = await tmp(t), server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`; const r = await fetch(base + '/api/notify/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10_000) }); assert.equal(r.status, 200); await r.body?.cancel();
  server.closeAllConnections(); await new Promise((res) => server.close(res)); assert.equal(JSON.parse(await readFile(path.join(dir, 'notify.json'), 'utf8')).seq, 1);
});

test('store.close(): cancels pending saves (nothing written after), or flushes first when asked', async (t) => {
  const dir = await tmp(t), a = path.join(dir, 'a.json'), b = path.join(dir, 'b.json');
  const s1 = await notifyStore(a, { saveMs: 30 }); s1.emit({ type: 'test' }); await s1.close(); await sleep(120); await assert.rejects(readFile(a, 'utf8'), { code: 'ENOENT' }, 'a cancelled save never happens'); s1.emit({ type: 'test' }); await sleep(80); assert.equal(s1.writes, 0, 'a closed store stays quiet');
  const s2 = await notifyStore(b, { saveMs: 5000 }); s2.emit({ type: 'test' }); await s2.close({ flush: true }); assert.equal(JSON.parse(await readFile(b, 'utf8')).seq, 1);
});

test('a failed write is retried by itself with backoff, capped, then stops; a new change starts over', async (t) => {
  const dir = await tmp(t), file = path.join(dir, 'gone', 'n.json'), seen = [];
  const s = await openStore(t, file, { saveMs: 5, retryMs: 20, maxRetries: 3, onError: (e) => seen.push(e.code) });
  s.emit({ type: 'test' }); const stable = async () => { let last = -1; for (let i = 0; i < 100; i++) { await sleep(60); if (s.writes === last) return s.writes; last = s.writes; } throw new Error('writes never settled: ' + s.writes); };
  assert.equal(await stable(), 4, '1 try + 3 retries, then it stops (no tight loop)'); assert.equal(s.health.ok, false); assert.deepEqual(seen, ['ENOENT', 'ENOENT', 'ENOENT', 'ENOENT']);
  s.emit({ type: 'test' }); assert.equal(await stable(), 8, 'a new change gets a fresh set of retries');
  await mkdir(path.dirname(file)); s.emit({ type: 'test' }); await waitFor(async () => (s.health.ok && s.writes > 8 ? true : null), { tries: 100, ms: 30 });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).seq, 3, 'recovered, with everything');
  // recovery without any new change: the disk comes back between the first failure and a retry
  const file2 = path.join(dir, 'later', 'n.json'), s2 = await openStore(t, file2, { saveMs: 5, retryMs: 80, maxRetries: 5, onError: () => {} });
  s2.emit({ type: 'test' }); await waitFor(async () => (s2.writes >= 1 ? true : null), { tries: 100, ms: 10 }); await mkdir(path.dirname(file2));
  await waitFor(async () => (s2.health.ok ? true : null), { tries: 100, ms: 30 }); assert.equal(JSON.parse(await readFile(file2, 'utf8')).seq, 1, 'the retry wrote it without another event');
  assert.ok(s2.writes <= 4, 'few attempts');
});

test('dropped: the rate-cap drop count is visible in /prefs and in the stream ready frame', async (t) => {
  const x = await hub(t), api = http.createServer((req, res) => { req.resume(); req.on('end', () => { if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); } res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'); }); });
  const up = await listen(api); t.after(() => { api.closeAllConnections(); api.close(); });
  assert.equal((await x.call('/api/connections', { name: 'glm', kind: 'openai', baseUrl: up + '/v1', model: 'm', apiKey: 'k' })).status, 201);
  assert.equal((await x.call('/api/notify/prefs')).body.dropped, 0);
  const ask = async () => { const r = await fetch(`${x.base}/api/agents/glm/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(10_000) }); await r.text(); };
  for (let i = 0; i < 62; i++) await ask(); // 60 per minute are kept
  await waitFor(async () => ((await x.call('/api/notify/prefs')).body.dropped >= 2 ? true : null), { tries: 100, ms: 50 });
  assert.equal((await x.call('/api/notify/prefs')).body.dropped, 2); assert.equal((await x.call('/api/notify/events?limit=500')).body.events.filter((e) => e.type === 'reply_finished').length, 60);
  const s = sse(t, `${x.base}/api/notify/stream`); const ready = await s.wait((f) => f.event === 'foxfleet.ready'); assert.equal(ready.data.dropped, 2); assert.equal(typeof ready.data.cursor, 'number');
});

test('OpenAPI: Retry-After on the 429, and 403/413/415 declared and real, for the notify routes', async (t) => {
  const routes = [['/api/notify/stream', 'get'], ['/api/notify/events', 'get'], ['/api/notify/prefs', 'get'], ['/api/notify/prefs', 'put'], ['/api/notify/mute', 'put'], ['/api/notify/test', 'post']];
  for (const [p, m] of routes) assert.ok(spec.paths[p][m].responses['403'], `${m} ${p} declares 403`);
  for (const [p, m] of routes.filter(([, m]) => m !== 'get')) { assert.ok(spec.paths[p][m].responses['413'], `${m} ${p} 413`); assert.ok(spec.paths[p][m].responses['415'], `${m} ${p} 415`); }
  const r429 = spec.paths['/api/notify/test'].post.responses['429']; assert.ok(r429.headers['Retry-After'], '/test 429 declares Retry-After'); assert.ok(spec.paths['/api/notify/stream'].get.responses['429']);
  const x = await hub(t), valid = (p, m, status, body) => { const decl = spec.paths[p][m].responses[String(status)]; assert.ok(decl, `${m} ${p} ${status} declared`); assert.deepEqual(validate(decl.content?.['application/json']?.schema ?? spec.components.responses.Error.content['application/json'].schema, body, spec), []); };
  const hit = async (p, m, init) => { const r = await fetch(x.base + p, { method: m, signal: AbortSignal.timeout(10_000), ...init }); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; };
  const bad = await hit('/api/notify/prefs', 'PUT', { headers: { 'Content-Type': 'text/plain' }, body: 'enabled=false' }); assert.equal(bad.status, 415); valid('/api/notify/prefs', 'put', 415, bad.body);
  const big = await hit('/api/notify/mute', 'PUT', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'a'.repeat(10_000), muted: true }) }); assert.equal(big.status, 413); valid('/api/notify/mute', 'put', 413, big.body);
  const cross = await hit('/api/notify/test', 'POST', { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' }); assert.equal(cross.status, 403); valid('/api/notify/test', 'post', 403, cross.body);
  for (let i = 0; i < 10; i++) await x.call('/api/notify/test', {}); const limited = await hit('/api/notify/test', 'POST', { headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60'); valid('/api/notify/test', 'post', 429, limited.body);
});
