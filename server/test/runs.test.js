// Chat runs survive client disconnects: the hub keeps reading the agent, buffers events and lets a client resume from a cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
import { runRegistry } from '../runs.js';

async function setup(t, connection) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-runs-')), configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: [connection] }));
  const server = await createHub({ configPath, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}
const frame = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
const post = (base, signal) => fetch(base + '/api/agents/fixture/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), signal });
const events = (text) => text.split('\n\n').filter((e) => e.trim() && !e.startsWith(':'));
const idOf = (e) => Number(/^id: (\d+)/m.exec(e)?.[1]);

test('a client that disconnects mid-stream does not stop the run; a reconnect resumes after its cursor', async (t) => {
  const words = ['one ', 'two ', 'three ', 'four ', 'five ', 'six '];
  const mock = await mockHermes(t, { streamFrames: words.map(frame), streamDelayMs: 60 }), base = await setup(t, mock.connection);
  const abort = new AbortController(), r = await post(base, abort.signal), run = r.headers.get('x-foxfleet-run'); assert.ok(run);
  const reader = r.body.getReader(), dec = new TextDecoder(); let seen = ''; while (!/two/.test(seen)) seen += dec.decode((await reader.read()).value);
  const cursor = Math.max(...events(seen).map(idOf).filter(Number.isFinite)); assert.ok(cursor >= 2);
  abort.abort(); await reader.cancel().catch(() => {});
  await new Promise((res) => setTimeout(res, 500)); // the client is gone for longer than the rest of the reply takes
  const list = await (await fetch(base + '/api/agents/fixture/runs?session_id=sess-1')).json(); assert.equal(list.runs[0].id, run); assert.equal(list.runs[0].state, 'done');
  const resumed = await fetch(base + `/api/agents/fixture/runs/${run}/events?after=${cursor}`), text = await resumed.text(), got = events(text);
  assert.ok(got.every((e) => idOf(e) > cursor), 'no event is repeated'); assert.deepEqual(got.map(idOf), got.map((_, i) => cursor + 1 + i), 'ids are contiguous');
  assert.ok(text.includes('six ') && text.includes('[DONE]'), 'the reply finished while the client was away');
  const viaHeader = await (await fetch(base + `/api/agents/fixture/runs/${run}/events`, { headers: { 'Last-Event-ID': String(cursor) } })).text(); assert.equal(viaHeader, text);
});

test('only an explicit stop cancels the agent', async (t) => {
  let closed = false; const mock = await mockHermes(t, { slowStream: true, onStreamClose: () => { closed = true; } }), base = await setup(t, mock.connection);
  const abort = new AbortController(), r = await post(base, abort.signal), run = r.headers.get('x-foxfleet-run'), reader = r.body.getReader(); await reader.read(); abort.abort(); await reader.cancel().catch(() => {});
  await new Promise((res) => setTimeout(res, 300)); assert.equal(closed, false, 'agent keeps running without a client');
  const live = await fetch(base + `/api/agents/fixture/runs/${run}/events?after=0`); const lr = live.body.getReader(); assert.ok((await lr.read()).value.length > 0, 'a new client can follow the live run');
  assert.equal((await fetch(base + `/api/agents/fixture/runs/${run}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  for (let i = 0; i < 40 && !closed; i++) await new Promise((res) => setTimeout(res, 50)); assert.equal(closed, true, 'stop aborts the upstream');
  assert.equal((await (await fetch(base + '/api/agents/fixture/runs')).json()).runs[0].state, 'stopped'); await lr.cancel().catch(() => {});
  assert.equal((await fetch(base + '/api/agents/fixture/runs/nope/events')).status, 404);
});

test('the replay log is bounded and says when events were dropped; finished runs expire', async () => {
  let t = 0; const reg = runRegistry({ maxBytes: 200, ttlMs: 1000, now: () => t });
  const body = new ReadableStream({ start(c) { for (let i = 0; i < 50; i++) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(20) + i } }] })}\n\n`)); c.close(); } });
  const run = await reg.start({ scope: 'u', agent: 'a', open: async () => new Response(body, { status: 200 }), timeoutMs: 1000, check: () => ({}) });
  await new Promise((r) => setTimeout(r, 30)); assert.equal(run.state, 'done'); assert.ok(run.log.length < 20 && run.next === 51);
  const out = []; const res = { writeHead() {}, write: (x) => out.push(x), end() {}, once() {} }; reg.attach({}, res, run, 0); assert.ok(out[0].startsWith('event: foxfleet.gap'));
  assert.ok(run.text.endsWith('x'.repeat(20) + '49')); assert.throws(() => reg.get('other', 'a', run.id), /gone/);
  t = 5000; assert.throws(() => reg.get('u', 'a', run.id), /gone/);
});
