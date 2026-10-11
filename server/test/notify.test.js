// Notifications phase 1: event log (bounded, persistent), per-agent / per-chat mute, resumable SSE stream with heartbeat,
// and the three event sources (reply finished, error, approval). Every server, stream and timer is closed in t.after; every wait has a hard timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../index.js';
import { notifyStore } from '../notify.js';
import { setup as setupNative } from './ui-helpers.js';
import { waitFor } from './machine-helpers.js';

const tmp = async (t) => { const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-notify-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })); return dir; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

async function hub(t, opts = {}) {
  const dir = await tmp(t), server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
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
  let a = await notifyStore(file, { maxEvents: 5 });
  for (let i = 0; i < 8; i++) a.emit({ type: 'reply_finished', agent: 'a', chat: `c${i}` });
  const { events, first, cursor } = a.since(0); assert.equal(events.length, 5); assert.equal(first, 4); assert.equal(cursor, 8); assert.deepEqual(events.map((e) => e.id), [4, 5, 6, 7, 8]);
  await a.setMute({ agent: 'a', muted: true }); await a.flush();
  assert.equal((await readFile(file, 'utf8')).includes('"seq":8'), true);
  const b = await notifyStore(file, { maxEvents: 5 }); assert.equal(b.cursor, 8); assert.deepEqual(b.since(6).events.map((e) => e.id), [7, 8]); assert.equal(b.prefs().agents[0].agent, 'a', 'mute survives a restart');
  assert.equal(b.emit({ type: 'error', agent: 'a' }).id, 9, 'the next id continues after a restart');
  assert.equal(b.fromRun({ agent: 'a', session: 's', id: 'r' }, 'stopped'), null, 'a run the user stopped is not a notification'); assert.equal(b.fromRun({ agent: 'a', session: 's', id: 'r' }, 'done').type, 'reply_finished'); assert.equal(b.fromRun({ agent: 'a', session: 's', id: 'r' }, 'error').type, 'error');
  assert.throws(() => b.emit({ type: 'nope' }), /unknown notification type/);
  await b.flush(); await writeBroken(file); assert.equal((await notifyStore(file)).cursor, 0, 'an unreadable file starts empty instead of crashing the hub');
});
async function writeBroken(file) { await (await import('node:fs/promises')).writeFile(file, '{not json'); }

test('store: mute rules (agent, chat, approval ignores a chat mute, expiry, master switch, validation)', async (t) => {
  let clock = 1_000_000; const s = await notifyStore(path.join(await tmp(t), 'n.json'), { now: () => clock });
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
  assert.deepEqual((await x.call('/api/notify/prefs')).body, { enabled: true, agents: [], chats: [] });
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
  const pre = await notifyStore(path.join(dir, 'notify.json'), { maxEvents: 500 }); for (let i = 0; i < 503; i++) pre.emit({ type: 'test' }); await pre.flush(); // 3 oldest dropped
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
