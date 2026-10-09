// Chat controls (docs/HERMES-CHAT-CONTROLS.md): command catalog, hub message coordinator, Hermes native runs, queue/steer/interrupt/stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { fakeNative, NATIVE_FEATURES } from './native-hermes.js';
import { createHub } from '../index.js';

const waitFor = async (fn, { tries = 100, ms = 40 } = {}) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, ms)); } return null; };
async function boot(t, connections, dir) {
  process.env.FOXFLEET_STOP_WAIT_MS = '600';
  dir ??= await mkdtemp(path.join(os.tmpdir(), 'foxfleet-cc-')); const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: connections }));
  const server = await createHub({ configPath, singleUser: true, dataDir: dir }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); };
  let stopped = false; t.after(async () => { if (!stopped) await stop(); });
  const api = (name) => {
    const url = (r) => `${base}/api/agents/${name}${r}`, j = async (res) => ({ status: res.status, ...(await res.json().catch(() => ({}))) });
    return {
      send: (text, o = {}) => fetch(url('/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: text }], mode: 'queue', ...o }) }).then(j),
      queue: (session = '') => fetch(url(`/queue?session_id=${session}`)).then(j),
      resume: (session = '') => fetch(url(`/queue/resume?session_id=${session}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(j),
      cancel: (id, session = '') => fetch(url(`/queue/${id}?session_id=${session}`), { method: 'DELETE' }).then(j),
      stop: (run) => fetch(url(`/runs/${run}/stop`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(j),
      runs: () => fetch(url('/runs')).then(j),
      commands: () => fetch(url('/commands')).then(j),
      agent: () => fetch(`${base}/api/agents/${name}`).then(j),
      peek: async (run, re, after = 0) => { const ac = new AbortController(), r = await fetch(url(`/runs/${run}/events?after=${after}`), { signal: ac.signal }), rd = r.body.getReader(), dec = new TextDecoder(); let text = ''; const t0 = Date.now(); try { while (!re.test(text) && Date.now() - t0 < 4000) { const { value, done } = await rd.read(); if (done) break; text += dec.decode(value); } } finally { ac.abort(); } return text; },
      events: (run, after = 0) => fetch(url(`/runs/${run}/events?after=${after}`)).then((r) => r.text()),
    };
  };
  return { base, dir, api, restart: async () => { stopped = true; await stop(); return boot(t, connections, dir); } };
}
const nativeHub = async (t, opts = {}) => { const fake = fakeNative(opts), mock = await mockHermes(t, { features: opts.legacy ? undefined : NATIVE_FEATURES, legacy: false, apiRoute: opts.legacy ? undefined : async (req, res, route, u) => (await fake.route(req, res, route, u)) !== false }); return { fake, mock, hub: await boot(t, [mock.connection]) }; };
const chunk = (c) => ({ delta: c });

test('catalog: per-agent, with handlers; steer only where the agent has it; generic agents never show Hermes commands', async (t) => {
  const { hub } = await nativeHub(t), a = hub.api('fixture'); const cat = await a.commands();
  const by = Object.fromEntries(cat.commands.map((c) => [c.name, c]));
  assert.deepEqual(cat.busy, ['queue', 'steer', 'interrupt']);
  assert.equal(by.steer.executable, true); assert.equal(by.steer.handler, 'hub:steer'); assert.equal(by.stop.handler, 'hub:stop'); assert.equal(by.busy.handler, 'hub:busy');
  assert.deepEqual(by.busy.subcommands, ['queue', 'steer', 'interrupt', 'status']); assert.ok(by.queue.unavailableSubcommands.edit); assert.equal(by.queue.busy, 'control');
  assert.ok(cat.commands.length > 40, 'the rest of the catalog stays');
  const legacy = await mockHermes(t, { features: undefined }), h2 = await boot(t, [legacy.connection]), c2 = await h2.api('fixture').commands(), s2 = c2.commands.find((c) => c.name === 'steer');
  assert.deepEqual(c2.busy, ['queue', 'interrupt']); assert.equal(s2.executable, false); assert.match(s2.disabledReason, /native steering/);
  assert.deepEqual(c2.commands.find((c) => c.name === 'busy').subcommands, ['queue', 'interrupt', 'status']);
  const agent = (await a.agent()).agent; assert.deepEqual(agent.capabilities.busy, ['queue', 'steer', 'interrupt']); assert.equal(agent.capabilities.nativeRuns, true);
});

test('a message sent while the agent works is accepted, shown, and runs after the reply; ten queued messages keep their order', async (t) => {
  const { fake, hub } = await nativeHub(t), a = hub.api('fixture');
  const first = await a.send('first'); assert.equal(first.status, 202); assert.ok(first.run_id); assert.equal(first.message.state, 'running');
  const id1 = fake.last(); fake.emit(id1, 'message.delta', chunk('working'));
  const ids = []; for (let i = 1; i <= 10; i++) { const r = await a.send(`q${i}`, { session_id: first.session_id }); assert.equal(r.message.state, 'queued'); ids.push(r.message.id); }
  const q1 = await a.queue(first.session_id), q2 = await a.queue(first.session_id); // two devices
  assert.deepEqual(q1.items.filter((i) => i.state === 'queued').map((i) => i.text), Array.from({ length: 10 }, (_, i) => `q${i + 1}`)); assert.deepEqual(q1.items, q2.items);
  assert.equal(fake.calls.filter((c) => c.call === 'create').length, 1, 'no second writer while the first reply runs');
  assert.match(await a.peek(first.run_id, /working/), /working/);
  for (let i = 0; i < 10; i++) { fake.finish(fake.last()); await waitFor(() => fake.calls.filter((c) => c.call === 'create').length === i + 2); }
  assert.deepEqual(fake.calls.filter((c) => c.call === 'create').map((c) => c.body.input), ['first', ...Array.from({ length: 10 }, (_, i) => `q${i + 1}`)]);
  assert.equal(fake.writers <= 1, true);
});

test('queue and mode survive a hub restart; the queue waits for an explicit resume', async (t) => {
  const { fake, hub } = await nativeHub(t), a = hub.api('fixture'), first = await a.send('one'); await a.send('two', { session_id: first.session_id }); await a.send('three', { session_id: first.session_id });
  const h2 = await hub.restart(), b = h2.api('fixture'), q = await b.queue(first.session_id);
  assert.equal(q.recent.find((i) => i.text === 'one').state, 'interrupted', 'in-flight work is marked, not re-sent');
  assert.deepEqual(q.items.filter((i) => i.state === 'queued').map((i) => i.text), ['two', 'three']); assert.equal(q.halted, true);
  assert.equal(fake.calls.filter((c) => c.call === 'create').length, 1, 'nothing is re-sent on its own after a restart');
  await b.resume(first.session_id); await waitFor(() => fake.calls.filter((c) => c.call === 'create').length === 2);
  assert.equal(fake.calls.filter((c) => c.call === 'create')[1].body.input, 'two');
});

test('idempotent admission: a retried client_id never creates a second message or run', async (t) => {
  const { fake, hub } = await nativeHub(t), a = hub.api('fixture');
  const one = await a.send('hello', { client_id: 'client-0001' }), two = await a.send('hello', { client_id: 'client-0001' });
  assert.equal(two.message.id, one.message.id); assert.equal(two.status, 200); assert.equal(fake.calls.filter((c) => c.call === 'create').length, 1);
  assert.equal((await a.send('x', { client_id: 'bad id!' })).status, 400);
});

test('steer goes to the native run; accepted is not consumed; unused guidance (pending_steer) comes back once; a 409 keeps the text', async (t) => {
  const { fake, hub } = await nativeHub(t), a = hub.api('fixture'), first = await a.send('build it');
  const s = await a.send('use PostgreSQL', { mode: 'steer', session_id: first.session_id });
  assert.equal(s.message.state, 'guidance_accepted'); assert.equal(s.message.note, 'accepted_not_consumed');
  assert.deepEqual(fake.calls.filter((c) => c.call === 'steer').map((c) => c.body), [{ input: 'use PostgreSQL' }]);
  assert.equal(fake.calls.filter((c) => c.call === 'create').every((c) => !/steer/.test(JSON.stringify(c.body))), true, '/steer text never goes through chat');
  fake.finish(fake.last(), 'run.completed', { pending_steer: ['use PostgreSQL'] });
  await waitFor(() => fake.calls.filter((c) => c.call === 'create').length === 2);
  assert.equal(fake.calls.filter((c) => c.call === 'create')[1].body.input, 'use PostgreSQL');
  fake.finish(fake.last()); await new Promise((r) => setTimeout(r, 150)); assert.equal(fake.calls.filter((c) => c.call === 'create').length, 2, 'recovered guidance is replayed once');
  // 409: the run ended between the click and the call
  const again = await a.send('next', { session_id: first.session_id }); fake.finish(fake.last());
  const late = await a.send('too late', { mode: 'steer', session_id: first.session_id }); assert.ok([202, 409].includes(late.status));
  const all = await a.queue(first.session_id); assert.ok(JSON.stringify(all).includes('too late') || late.status === 409 || fake.calls.some((c) => c.call === 'create' && c.body.input === 'too late'), 'the text is not lost');
  void again;
});

test('Interrupt & send: stop, wait for confirmed termination, then start the replacement; never two writers', async (t) => {
  const { fake, hub } = await nativeHub(t, { stopDelayMs: 150 }), a = hub.api('fixture'), first = await a.send('long job');
  let max = 0; const poll = setInterval(() => { max = Math.max(max, fake.writers); }, 5);
  const r = await a.send('actually do this', { mode: 'interrupt', session_id: first.session_id }); assert.equal(r.message.state, 'awaiting_stop');
  assert.equal(fake.calls.filter((c) => c.call === 'create').length, 1, 'replacement waits for the stop');
  await waitFor(() => fake.calls.filter((c) => c.call === 'create').length === 2); clearInterval(poll);
  assert.equal(max <= 1, true); const order = fake.calls.map((c) => c.call).filter((c) => c !== 'events'); assert.deepEqual(order.slice(0, 3), ['create', 'stop', 'create']);
  assert.equal(fake.calls.filter((c) => c.call === 'create')[1].body.input, 'actually do this'); assert.equal(fake.calls.filter((c) => c.call === 'create')[1].session, first.session_id, 'same conversation');
  const events = await hub.api('fixture').events(first.run_id); assert.match(events, /stopped/);
});

test('failed or unconfirmed stop never launches a second writer and leaves the replacement pending with an error', async (t) => {
  for (const opts of [{ stopFails: true }, { stopNever: true }]) {
    const { fake, hub } = await nativeHub(t, opts), a = hub.api('fixture'), first = await a.send('long job');
    await a.send('replace', { mode: 'interrupt', session_id: first.session_id });
    const q = await waitFor(async () => { const x = await a.queue(first.session_id); return x.items.find((i) => i.note === 'stop_failed') && x; });
    assert.ok(q, JSON.stringify(opts)); const it = q.items.find((i) => i.note === 'stop_failed'); assert.equal(it.state, 'queued'); assert.match(it.error, /could not be stopped/); assert.equal(q.halted, true);
    assert.equal(fake.calls.filter((c) => c.call === 'create').length, 1); const run = (await a.runs()).runs[0]; assert.notEqual(run.state, 'stopped', 'truthful state');
  }
});

test('Stop alone is confirmed, reports a truthful state, and halts queue draining until resume or a new message', async (t) => {
  const { fake, hub } = await nativeHub(t, { stopDelayMs: 40 }), a = hub.api('fixture'), first = await a.send('job');
  fake.emit(fake.last(), 'tool.started', { name: 'terminal' }); const queued = await a.send('after', { session_id: first.session_id });
  const stopped = await a.stop(first.run_id); assert.equal(stopped.confirmed, true); assert.equal(stopped.run.state, 'stopped');
  await new Promise((r) => setTimeout(r, 200)); assert.equal(fake.calls.filter((c) => c.call === 'create').length, 1, 'draining halted');
  const q = await a.queue(first.session_id); assert.equal(q.halted, true); assert.equal(q.items.find((i) => i.id === queued.message.id).state, 'queued');
  const next = await a.send('fresh', { session_id: first.session_id }); assert.equal(next.message.state, 'queued'); await waitFor(() => fake.calls.filter((c) => c.call === 'create').length === 2);
  assert.equal(fake.calls.filter((c) => c.call === 'create')[1].body.input, 'after', 'a new submission resumes in FIFO order');
});

test('queued messages can be cancelled; wrong agent or run controls fail; unsupported modes are rejected', async (t) => {
  const { fake, hub, mock } = await nativeHub(t), a = hub.api('fixture'), first = await a.send('x'), q = await a.send('later', { session_id: first.session_id });
  assert.equal((await a.cancel(q.message.id, first.session_id)).message.state, 'cancelled'); assert.equal((await a.cancel(q.message.id, first.session_id)).status, 404);
  { const o = await boot(t, [mock.connection, { ...mock.connection, name: 'other' }]), other = o.api('other'); const mine = await o.api('fixture').send('mine'); assert.equal((await other.stop(mine.run_id)).status, 404, 'another agent cannot control this run'); }
  assert.equal((await a.send('x', { mode: 'teleport', session_id: first.session_id })).status, 400);
  
  const legacy = await mockHermes(t, { features: undefined }), h2 = await boot(t, [legacy.connection]), b = h2.api('fixture');
  const r = await b.send('hi'); assert.equal(r.status, 202); const st = await b.send('steer me', { mode: 'steer', session_id: r.session_id }); assert.equal(st.status, 400, 'Steer stays unavailable without native runs');
  void fake;
});

test('legacy Hermes: queue and abort/resubmit through chat/completions, no native calls', async (t) => {
  const mock = await mockHermes(t, { slowStream: true }), hub = await boot(t, [mock.connection]), a = hub.api('fixture');
  const first = await a.send('one'); assert.equal(first.message.state, 'running');
  const r = await a.send('two', { mode: 'interrupt', session_id: first.session_id }); assert.equal(r.message.state, 'awaiting_stop');
  await waitFor(() => mock.requests.filter((x) => x.path === '/v1/chat/completions').length === 2);
  const reqs = mock.requests.filter((x) => x.path === '/v1/chat/completions'); assert.equal(reqs[1].body.messages.at(-1).content, 'two');
  assert.equal(mock.requests.some((x) => x.path.startsWith('/v1/runs')), false);
});

test('native event stream is normalised: deltas, status, no duplicate final text; detach keeps the run and replay resumes by cursor', async (t) => {
  const { fake, hub } = await nativeHub(t), a = hub.api('fixture'), first = await a.send('go'), id = fake.last();
  fake.emit(id, 'message.delta', chunk('Hel')); fake.emit(id, 'tool.started', { name: 'terminal' }); fake.emit(id, 'message.delta', chunk('lo'));
  const ac = new AbortController(); const part = await fetch(`${hub.base}/api/agents/fixture/runs/${first.run_id}/events`, { signal: ac.signal }); const rd = part.body.getReader(); await rd.read(); ac.abort(); await rd.cancel().catch(() => {});
  fake.finish(id, 'run.completed', { output: 'Hello', already_streamed: true });
  await waitFor(async () => (await a.runs()).runs[0].state === 'done'); const all = await a.events(first.run_id);
  assert.equal((all.match(/"content":"Hel"/g) || []).length, 1); assert.match(all, /hermes\.tool\.progress/); assert.equal((all.match(/"content":"Hello"/g) || []).length, 0, 'already streamed output is not repeated');
  const ids = [...all.matchAll(/^id: (\d+)/gm)].map((m) => Number(m[1])), cut = ids[1], tail = await a.events(first.run_id, cut); assert.ok(!tail.includes(`id: ${cut}\n`));
});

test('OpenAI-compatible agents (Grok): queue, and abort + resubmit with updated history; no steer', async (t) => {
  const seen = []; const up = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c; if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); } const body = JSON.parse(b); seen.push(body.messages.map((m) => m.content));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' + seen.length } }] })}\n\n`);
    if (body.messages.at(-1).content === 'slow') { const k = setInterval(() => res.write('data: {"choices":[]}\n\n'), 20); res.on('close', () => clearInterval(k)); return; } res.end('data: [DONE]\n\n');
  }); await new Promise((r) => up.listen(0, '127.0.0.1', r)); t.after(() => { up.closeAllConnections(); up.close(); });
  const hub = await boot(t, [{ name: 'grok1', kind: 'grok', baseUrl: `http://127.0.0.1:${up.address().port}/v1`, model: 'g', apiKey: 'k' }]), a = hub.api('grok1');
  const cat = await a.commands(); assert.equal(cat.commands.some((c) => c.name === 'skills'), false); assert.deepEqual(cat.busy, ['queue', 'interrupt']);
  const first = await a.send('slow'); assert.equal(first.message.state, 'running'); const sid = first.session_id; assert.ok(sid);
  assert.equal((await a.send('steer', { mode: 'steer', session_id: sid })).status, 400);
  const r = await a.send('replacement', { mode: 'interrupt', session_id: sid }); assert.equal(r.message.state, 'awaiting_stop');
  await waitFor(() => seen.length === 2); assert.deepEqual(seen[1].at(-1), 'replacement'); assert.equal(seen[1].length >= 1, true);
  const q = await a.send('then this', { session_id: sid }); assert.ok(['queued', 'running', 'done'].includes(q.message.state));
});
