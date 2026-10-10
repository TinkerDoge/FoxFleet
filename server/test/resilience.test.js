// "Cloudflare blips": a fault-injecting proxy in front of the hub. Sessions stay signed in, runs keep going, nothing is duplicated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
import { faultProxy } from './fault-proxy.js';
import { waitFor } from './machine-helpers.js';

async function setup(t, connection) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-res-')), configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: [connection] }));
  const server = await createHub({ configPath, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { port: server.address().port, host: '127.0.0.1' };
}
const frame = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
const parse = (text) => text.split('\n\n').filter((e) => /^id: \d+/m.test(e)).map((e) => ({ id: Number(/^id: (\d+)/m.exec(e)[1]), data: e.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('') }));
const textOf = (evs) => evs.map((e) => { try { return JSON.parse(e.data).choices[0].delta.content; } catch { return ''; } }).join('');

test('the tunnel dies mid-reply: the run keeps going on the hub, the client reconnects through 502s and gets the whole reply once', async (t) => {
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'epsilon ', 'zeta '];
  const mock = await mockHermes(t, { streamFrames: words.map(frame), streamDelayMs: 80 }), hub = await setup(t, mock.connection), px = await faultProxy(t, hub);
  const r = await fetch(px.base + '/api/agents/fixture/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  const run = r.headers.get('x-foxfleet-run'); assert.ok(run); const reader = r.body.getReader(), dec = new TextDecoder(); let seen = '';
  while (!/beta/.test(seen)) seen += dec.decode((await reader.read()).value);
  const first = parse(seen); const cursor = Math.max(...first.map((e) => e.id));
  px.resetAll(); await reader.read().catch(() => {}); // the client sees the stream die
  const outage = px.outage(600);                      // and the tunnel is down for a while
  const during = await fetch(px.base + `/api/agents/fixture/runs/${run}/events?after=${cursor}`).catch(() => ({ status: 0 }));
  assert.ok([0, 502].includes(during.status), 'during the outage the client sees a gateway error, nothing else'); await outage;
  const back = await fetch(px.base + `/api/agents/fixture/runs/${run}/events?after=${cursor}`), rest = parse(await back.text());
  assert.ok(rest.every((e) => e.id > cursor), 'nothing repeated'); assert.equal(textOf([...first, ...rest]), words.join(''), 'the whole reply, once');
  const list = await (await fetch(px.base + '/api/agents/fixture/runs?session_id=sess-1')).json(); assert.equal(list.runs[0].state, 'done', 'the run was never failed by the blip');
});

test('a 502 storm does not log anyone out: auth and agents answer again as soon as the tunnel is back', async (t) => {
  const mock = await mockHermes(t), hub = await setup(t, mock.connection), px = await faultProxy(t, hub);
  assert.equal((await fetch(px.base + '/api/agents')).status, 200);
  px.mode = '502'; for (let i = 0; i < 5; i++) { const x = await fetch(px.base + '/api/agents'); assert.equal(x.status, 502); }
  px.mode = 'pass'; const a = await fetch(px.base + '/api/auth'); assert.equal(a.status, 200); assert.equal((await fetch(px.base + '/api/agents')).status, 200);
});

test('event streams carry a retry hint and a first byte at once, and the headers a proxy needs', async (t) => {
  const mock = await mockHermes(t, { slowStream: true }), hub = await setup(t, mock.connection);
  const r = await fetch(`http://127.0.0.1:${hub.port}/api/agents/fixture/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  const run = r.headers.get('x-foxfleet-run'); await r.body.cancel();
  const ev = await fetch(`http://127.0.0.1:${hub.port}/api/agents/fixture/runs/${run}/events`); assert.match(ev.headers.get('cache-control'), /no-transform/); assert.equal(ev.headers.get('x-accel-buffering'), 'no');
  const reader = ev.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /^retry: 3000\n\n/); await reader.cancel();
  await fetch(`http://127.0.0.1:${hub.port}/api/agents/fixture/runs/${run}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
});

test('/health/stream (the doctor probe) streams live, unauthenticated, with the no-buffering headers', async (t) => {
  const mock = await mockHermes(t, {}), hub = await setup(t, mock.connection);
  const t0 = Date.now(), r = await fetch(`http://127.0.0.1:${hub.port}/health/stream`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/event-stream/); assert.match(r.headers.get('cache-control'), /no-transform/); assert.equal(r.headers.get('x-accel-buffering'), 'no');
  const rd = r.body.getReader(); await rd.read(); assert.ok(Date.now() - t0 < 300, 'first bytes are immediate'); while (!(await rd.read()).done); assert.ok(Date.now() - t0 > 1000);
});
