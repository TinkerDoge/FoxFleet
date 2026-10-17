// SIGTERM / SIGINT with apps connected (Soran recheck R1): a real hub process ends every open event stream (live v1, live v2,
// notifications) and exits well inside the 10 s Docker grace, the live log records a clean stop, and the cursors clients hold
// still resume after the restart (no `expired` gap, no full resync).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sse, sleep, hub, hermes, PASS } from './live2-helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function start(t, dir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...process.env, FOXFLEET_CONFIG: path.join(dir, 'config.json'), FOXFLEET_PORT: String(port), FOXFLEET_HOST: '127.0.0.1', FOXFLEET_PASSWORD: PASS }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', exited = null; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((r) => child.once('exit', (code, sig) => { exited = { code, sig, at: Date.now() }; r(exited); }));
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await Promise.race([exit, sleep(5000)]); } });
  for (let i = 0; i < 100 && !/Foxfleet listening/.test(out); i++) { if (exited) throw new Error('hub exited early: ' + out); await sleep(100); }
  assert.match(out, /Foxfleet listening/);
  const base = `http://127.0.0.1:${port}`;
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: PASS, client: 'app' }), signal: AbortSignal.timeout(10_000) });
  const h = { Authorization: `Bearer ${(await r.json()).token}` };
  const call = async (p, body, method) => { const x = await fetch(base + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { ...h, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) }); return { status: x.status, body: await x.json().catch(() => null) }; };
  return { child, exit, base, h, call, out: () => out, get exited() { return exited; } };
}
const meta = async (dir) => { const f = (await readdir(dir, { recursive: true })).find((x) => x.endsWith('live-events.json')); assert.ok(f, 'live-events.json exists'); return JSON.parse(await readFile(path.join(dir, f), 'utf8')); };

for (const signal of ['SIGTERM', 'SIGINT']) test(`${signal} with live v1, v2 and notification streams open: exits within the grace, clean stop, cursors still resume`, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-stop-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const port = await freePort(), a = await start(t, dir, port);
  const snap = await a.call('/api/chats'); assert.equal(snap.status, 200);
  await a.call('/api/notify/test', {}); // one persisted live event at least, so the cursor below is past 0
  const v2 = sse(t, `${a.base}/api/live/stream?v=2&since=${snap.body.cursor}`, a.h), v1 = sse(t, `${a.base}/api/live/stream`, a.h), nt = sse(t, `${a.base}/api/notify/stream`, a.h);
  const ready = await v2.wait((f) => f.event === 'foxfleet.ready'); await v1.wait((f) => f.event === 'foxfleet.ready'); await nt.wait((f) => f.event === 'foxfleet.ready' || f.comment || f.event === 'notify');
  const cursor = ready.data.cursor;
  assert.equal((await meta(dir)).clean, false, 'running: not clean yet');
  const t0 = Date.now(); a.child.kill(signal);
  const ex = await Promise.race([a.exit, sleep(8000).then(() => null)]);
  assert.ok(ex, `the hub exited after ${signal} with streams open (output: ${a.out().slice(-500)})`);
  assert.ok(ex.at - t0 < 4000, `exited in ${ex.at - t0} ms`); assert.equal(ex.code, 0);
  const m = await meta(dir); assert.equal(m.clean, true, 'the stop is recorded clean'); assert.ok(m.seq >= Number(cursor.split(':')[1]), 'the exact counter is kept');
  await sleep(100); assert.ok(v2.done || v2.frames.length, 'the v2 stream ended');
  // restart on the same data: the old cursor resumes without a gap
  const b = await start(t, dir, port);
  const again = sse(t, `${b.base}/api/live/stream?v=2&since=${cursor}`, b.h); const r2 = await again.wait((f) => f.event === 'foxfleet.ready');
  assert.equal(again.frames.find((f) => f.event === 'foxfleet.gap'), undefined, 'no gap after a clean stop'); assert.equal(r2.data.store, ready.data.store);
  const pull = await b.call(`/api/live/events?since=${cursor}`); assert.equal(pull.status, 200);
  b.child.kill('SIGTERM'); const ex2 = await Promise.race([b.exit, sleep(8000).then(() => null)]); assert.ok(ex2, 'second stop with a stream open'); assert.equal((await meta(dir)).clean, true);
});

test('server.shutdown() also ends run streams (a reply still streaming) and resolves after the stores are closed', async (t) => {
  const { mock } = await hermes(t, { slowStream: true });
  const x = await hub(t); assert.equal((await x.call('/api/connections', { ...mock.connection, name: 'atlas' })).status, 201);
  const r = await fetch(`${x.base}/api/agents/atlas/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  const run = r.headers.get('x-foxfleet-run'); assert.ok(run); await r.body.cancel();
  const ev = await fetch(`${x.base}/api/agents/atlas/runs/${run}/events`); const reader = ev.body.getReader(); await reader.read();
  const ended = (async () => { try { for (;;) { const { done } = await reader.read(); if (done) return true; } } catch { return true; } })();
  const live = sse(t, `${x.base}/api/live/stream?v=2`); await live.wait((f) => f.event === 'foxfleet.ready');
  const t0 = Date.now(); await Promise.race([x.server.shutdown({ timeoutMs: 3000 }), sleep(6000).then(() => assert.fail('shutdown did not resolve'))]);
  assert.ok(Date.now() - t0 < 2500, `stopped in ${Date.now() - t0} ms (before the hard timeout)`);
  assert.equal(await Promise.race([ended, sleep(2000).then(() => false)]), true, 'the run stream ended');
  const metaFile = (await readdir(x.dir, { recursive: true })).find((f) => f.endsWith('live-events.json'));
  assert.equal(JSON.parse(await readFile(path.join(x.dir, metaFile), 'utf8')).clean, true);
});
