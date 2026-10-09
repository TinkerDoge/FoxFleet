// Hub adapter for the native Hermes UI gateway: HTTP API -> hub journal/ownership/event contract -> real connector -> gateway (fake by default).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './machine-helpers.js';
import { setup, REAL } from './ui-helpers.js';
import { nativeHub, normalise, CONTRACT } from '../hermes-ui.js';

async function boot(t) {
  const x = await setup(t), json = async (route, data) => { const r = await fetch(x.base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await waitFor(async () => { const a = (await json('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  const A = '/api/agents/default/native';
  // follow the SSE stream; returns { events, stop }
  function follow(sid, after = 0) {
    const ac = new AbortController(), events = []; let id = 0;
    const done = fetch(`${x.base}${A}/sessions/${sid}/events?after=${after}`, { signal: ac.signal }).then(async (r) => { const dec = new TextDecoder(); let buf = ''; for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.*)$/m.exec(raw); if (d) events.push(JSON.parse(d[1])); } } }).catch(() => {});
    t.after(() => ac.abort()); return { events, stop: () => ac.abort(), done, wait: (pred, o = { tries: 150, ms: 100 }) => waitFor(async () => events.find(pred) ?? null, o) };
  }
  return { ...x, json, A, follow };
}

test('capability negotiation: native UI is advertised with its own modes and contract; plain agents get native:false', async (t) => {
  const x = await boot(t); const a = (await x.json('/api/agents')).body.agents[0];
  assert.equal(a.capabilities.nativeUi, true); assert.deepEqual(a.capabilities.busy, ['queue', 'steer', 'interrupt']);
  assert.deepEqual((await x.json(x.A)).body, { native: true, protocol: 'tui-gateway-jsonrpc', modes: ['auto', 'queue', 'steer', 'interrupt'], contract: CONTRACT });
});

test('journaled send: hub id first, upstream ack mirrored (never predicted), versioned events with distinct ids, no hub queue', async (t) => {
  const x = await boot(t), created = await x.json(`${x.A}/sessions`, {}); assert.equal(created.status, 201); const sid = created.body.session_id;
  const f = x.follow(sid); assert.equal((await x.json(`${x.A}/sessions/${sid}/attach`, {})).status, 200);
  const sent = await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'slow story', client_id: 'client-0001' }); assert.equal(sent.status, 202);
  assert.match(sent.body.message.id, /^m_/); assert.equal(sent.body.message.state, 'acked'); assert.equal(sent.body.message.ack, 'streaming');
  const dup = await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'slow story', client_id: 'client-0001' }); assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true); assert.equal(dup.body.message.id, sent.body.message.id, 'idempotent admission');
  const start = await f.wait((e) => e.type === 'turn.start'); assert.ok(start && start.turn_id.startsWith('t_') && start.session_id === sid && start.v === 1);
  const ack = (m) => m.ack;
  const q = await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'then bye', mode: 'queue' }); assert.equal(ack(q.body.message), 'queued');
  const st = await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'make it about foxes', mode: 'steer' }); assert.equal(ack(st.body.message), 'queued', 'Hermes answers queued for steer: that is what is shown, not "steered"');
  const rd = await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'redirect please', mode: 'interrupt' }); assert.equal(rd.body.message.state, 'rejected'); assert.match(rd.body.message.note, /Queue, Steer, or Stop/, 'a rejected redirect stays visible and is not silently turned into a stop');
  const ackEv = await f.wait((e) => e.type === 'ack' && e.message_id === q.body.message.id); assert.ok(ackEv);
  { const qq = (await x.json(`/api/agents/default/queue?session_id=${sid}`)).body; assert.equal(qq.halted, false, 'the hub has no queue of its own to pause'); assert.ok(qq.items.every((i) => i.ack), 'every item is a mirror of what Hermes acknowledged'); assert.equal(qq.can_cancel, false); }
  const list = (await x.json(`${x.A}/sessions/${sid}/messages`)).body.messages; assert.deepEqual(list.map((m) => m.mode), ['auto', 'queue', 'steer', 'interrupt']);
  await x.json(`${x.A}/sessions/${sid}/interrupt`, {});
  assert.ok(await f.wait((e) => e.type === 'turn.end' && e.status === 'interrupted'), 'partial answer ends as interrupted, not lost');
  assert.ok(f.events.every((e) => e.v === 1 && e.session_id === sid)); assert.ok(f.events.map((e) => e.seq).every((n, i, a) => i === 0 || n > a[i - 1]));
});

test('two viewers, one owner: one leaving does not cancel the run; a cursor resumes without gaps or duplicates; snapshot restores partial + queued', async (t) => {
  const x = await boot(t), sid = (await x.json(`${x.A}/sessions`, {})).body.session_id;
  const a = x.follow(sid), b = x.follow(sid); await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'slow story' });
  assert.ok(await a.wait((e) => e.type === 'message.delta') && await b.wait((e) => e.type === 'message.delta'));
  await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'after this', mode: 'queue' });
  a.stop(); const seen = a.events.at(-1).seq;
  // a new device attaches mid-turn: same owner, state restored from the snapshot
  const snap = (await x.json(`${x.A}/sessions/${sid}/attach`, {})).body; assert.equal(snap.running, true); assert.equal(snap.inflight.user, 'slow story'); assert.ok(snap.inflight.assistant.length > 0); assert.deepEqual(snap.queued, ['after this']); assert.equal(snap.contract, 'foxfleet.native/1');
  const c = x.follow(sid, seen); assert.ok(await b.wait((e) => e.type === 'turn.end', { tries: 120, ms: 100 }), 'viewer b still receives the end: viewer a leaving did not cancel the run');
  assert.equal(b.events.find((e) => e.type === 'turn.end').status, 'complete');
  await c.wait((e) => e.type === 'turn.end'); const seqs = [...a.events.map((e) => e.seq), ...c.events.map((e) => e.seq)]; const uniq = [...new Set(seqs)]; assert.equal(uniq.length, seqs.length, 'no duplicate events across the cursor');
  assert.deepEqual(c.events.map((e) => e.seq), b.events.filter((e) => e.seq > seen).map((e) => e.seq), 'the resumed viewer sees exactly what the other saw after the cursor');
});

test('approvals/clarifications: card data, respond once by id, cancel by id, restored after reconnect', async (t) => {
  const x = await boot(t), sid = (await x.json(`${x.A}/sessions`, {})).body.session_id, f = x.follow(sid);
  await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'please clarify env' });
  const open = await f.wait((e) => e.type === 'request.open'); assert.ok(open); assert.equal(open.kind, 'clarify'); assert.ok(open.questions[0].choices[0].startsWith('staging') && open.questions[0].choices.includes('production')); // a real Hermes decorates the recommended choice assert.match(open.request_id, /^srq-/);
  const again = (await x.json(`${x.A}/sessions/${sid}/attach`, {})).body; assert.equal(again.open_requests.length, 1, 'question returns after reconnect'); assert.equal(again.open_requests[0].request_id, open.request_id);
  assert.equal((await x.json(`${x.A}/sessions/${sid}/requests/${open.request_id}`, { result: { answers: { q0: 'staging' } } })).status, 200);
  assert.equal((await x.json(`${x.A}/sessions/${sid}/requests/${open.request_id}`, { result: { answers: { q0: 'production' } } })).status, 404, 'answered once');
  assert.ok(await f.wait((e) => e.type === 'request.answered' && e.request_id === open.request_id)); assert.ok(await f.wait((e) => e.type === 'turn.end'));
  await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'clarify again' }); const second = await f.wait((e) => e.type === 'request.open' && e.request_id !== open.request_id); assert.ok(second);
  await x.json(`${x.A}/sessions/${sid}/interrupt`, {}); const cancel = await f.wait((e) => e.type === 'request.cancel' && e.request_id === second.request_id); assert.ok(cancel);
  assert.equal((await x.json(`${x.A}/sessions/${sid}/attach`, {})).body.open_requests.length, 0); assert.equal((await x.json(`${x.A}/sessions/${sid}/requests/${second.request_id}`, { result: {} })).status, 404);
});

test('models and commands pass through the allowlist; /model is session scoped; profile defaults are refused', async (t) => {
  const x = await boot(t), sid = (await x.json(`${x.A}/sessions`, {})).body.session_id;
  const models = (await x.json(`${x.A}/models`)).body; assert.ok(models.providers.length > 0 && models.providers.every((p) => p.slug && Array.isArray(p.models)));
  const nativeCmds = (await x.json(`${x.A}/commands`)).body;
  assert.ok(nativeCmds.pairs.some(([n]) => n === '/busy'));
  assert.equal(nativeCmds.skills['/deploy-notes'].origin, 'project');
  assert.equal(nativeCmds.skill_count, 1);
  const pub = (await x.json('/api/agents/default/commands')).body;
  assert.equal(pub.source, 'agent');
  assert.ok(pub.skills.includes('deploy-notes'));
  assert.equal(pub.commands.find((c) => c.name === 'ship').executable, false, 'a live name is not permission to run it');
  assert.ok(pub.commands.some((c) => c.name === 'model'));
  assert.equal((await x.json(`/api/agents/default/commands?session=${sid}`)).body.warning, 'session catalog');
  const m = await x.json(`${x.A}/sessions/${sid}/model`, { model: 'fake-model' }); assert.equal(m.status, 200); assert.equal(m.body.scope, 'session');
  assert.equal((await x.json(`${x.A}/sessions/${sid}/model`, { model: 'x --global' })).status >= 400, true);
});

test('hub link drop mid-turn: the owner on the machine keeps running, the viewer re-attaches and the turn is not duplicated', async (t) => {
  const x = await boot(t), sid = (await x.json(`${x.A}/sessions`, {})).body.session_id, f = x.follow(sid);
  await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'slow story' }); assert.ok(await f.wait((e) => e.type === 'message.delta'));
  x.server.connectors.drop(x.machine.id); assert.ok(await f.wait((e) => e.type === 'link' && e.state === 'down'));
  await waitFor(async () => { const u = x.server.connectors.ui(x.machine.id); return u && u.caps('default') ? 1 : 0; }, { tries: 80, ms: 150 });
  const snap = (await x.json(`${x.A}/sessions/${sid}/attach`, {})).body; assert.equal(snap.running, true);
  assert.ok(await f.wait((e) => e.type === 'turn.end', { tries: 150, ms: 100 }), 'live events continue through the new link'); assert.equal(f.events.filter((e) => e.type === 'turn.start').length, 1, 'no duplicate turn');
});

test('gateway crash: journal marks in-flight messages uncertain (never resent), viewers are told the owner went down', async (t) => {
  if (REAL) return t.skip('crash needs the fake gateway');
  const x = await boot(t), sid = (await x.json(`${x.A}/sessions`, {})).body.session_id, f = x.follow(sid);
  const r = await x.json(`${x.A}/sessions/${sid}/messages`, { text: 'crash please' });
  // the gateway dies right after answering: the hub either recorded the answer first or learned of the crash first. Both end 'uncertain', and the message is never sent twice.
  assert.ok(['acked', 'uncertain'].includes(r.body.message.state), `unexpected ${r.body.message.state}`);
  const down = await f.wait((e) => e.type === 'owner.down'); assert.ok(down);
  const list = await waitFor(async () => { const l = (await x.json(`${x.A}/sessions/${sid}/messages`)).body.messages; return l[0]?.state === 'uncertain' ? l : null; }, { tries: 80, ms: 100 }); assert.ok(list, 'the in-flight message ends uncertain');
  assert.equal(list.length, 1, 'never resent'); assert.equal(f.events.filter((e) => e.type === 'turn.start').length, 1); assert.match(list[0].note, /check the transcript before resending/);
});

test('an answer that arrives after the gateway went down is recorded as uncertain, never acked, and nothing is resent', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-nh-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let release; const gate = new Promise((r) => { release = r; }), calls = []; let listener;
  const ui = { caps: () => ({ native: true }), subscribe: (fn) => { listener = fn; }, call: async (agent, op, params) => { calls.push(op); if (op === 'submit') await gate; return stub.reply(op, params); } };
  const hub = await nativeHub({ connectors: { ui: () => ui }, file: path.join(dir, 'j.json') }); const s = await hub.create('u1', 'm1', 'p');
  const sending = hub.send('u1', 'm1', 'p', s.session_id, { text: 'hello' });
  await waitFor(async () => calls.includes('submit'), { tries: 100, ms: 20 });
  listener('p', { kind: 'gateway.down', code: 7 }); // the owner died while the answer was still on its way
  release(); const r = await sending;
  assert.equal(r.message.state, 'uncertain'); assert.match(r.message.note, /check the transcript before resending/);
  assert.equal(calls.filter((c) => c === 'submit').length, 1);
  assert.equal(hub.list('u1', 'p', s.session_id)[0].state, 'uncertain');
});

// ---- hub unit tests with a scripted upstream: ownership, restart reconcile, event mapping ----
function stub() {
  const calls = []; let listener; const ui = { caps: () => ({ native: true }), subscribe: (fn) => { listener = fn; }, call: async (agent, op, params) => { calls.push([op, params]); return stub.reply(op, params); } };
  return { connectors: { ui: () => ui }, calls, emit: (ev) => listener('p', ev) };
}
stub.reply = (op) => (op === 'create' ? { session_id: 'rt1', stored_session_id: 'S1' } : op === 'attach' ? { session_id: 'rt1', running: false, messages: [] } : op === 'events.since' ? { events: [], latest_seq: 0, epoch: 'e' } : op === 'submit' ? { status: 'streaming', user_row_id: 5 } : {});

test('ownership: a session belongs to the account that created it; others are refused before any attach or send', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-nh-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const s = stub(), hub = await nativeHub({ connectors: s.connectors, file: path.join(dir, 'j.json') });
  const c = await hub.create('alice', 'M1', 'p'); assert.equal(c.session_id, 'S1');
  for (const fn of [() => hub.attach('bob', 'M1', 'p', 'S1'), () => hub.send('bob', 'M1', 'p', 'S1', { text: 'hi' }), () => hub.interrupt('bob', 'M1', 'p', 'S1'), () => hub.respond('bob', 'M1', 'p', 'S1', 'srq-1', { result: {} }), () => hub.follow('bob', 'M1', 'p', 'S1', 0, () => {})]) await assert.rejects(Promise.resolve().then(fn), (e) => e.status === 404);
  assert.ok(!s.calls.some(([op]) => op === 'attach'), 'nothing reached the machine for the foreign account');
  assert.equal((await hub.send('alice', 'M1', 'p', 'S1', { text: 'hi' })).message.ack, 'streaming');
});

test('restart: a message that was being sent when the hub stopped is uncertain, reconciled against the snapshot, never resent', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-nh-')); t.after(() => rm(dir, { recursive: true, force: true })); const file = path.join(dir, 'j.json');
  await writeFile(file, JSON.stringify({ owners: { S1: 'alice' }, messages: [{ id: 'm_1', agent: 'p', session: 'S1', scope: 'alice', text: 'in the transcript', mode: 'auto', state: 'sending', created: 1 }, { id: 'm_2', agent: 'p', session: 'S1', scope: 'alice', text: 'lost', mode: 'auto', state: 'sending', created: 2 }] }));
  const s = stub(); stub.reply = (op) => (op === 'attach' ? { session_id: 'rt9', running: false, messages: [{ role: 'user', content: 'in the transcript' }] } : op === 'events.since' ? { events: [], latest_seq: 0, epoch: 'e' } : {});
  const hub = await nativeHub({ connectors: s.connectors, file }); assert.deepEqual(hub.list('alice', 'p', 'S1').map((m) => m.state), ['uncertain', 'uncertain']);
  await hub.attach('alice', 'M1', 'p', 'S1'); const after = hub.list('alice', 'p', 'S1'); assert.equal(after[0].state, 'acked'); assert.equal(after[0].ack, 'reconciled'); assert.equal(after[1].state, 'uncertain'); assert.match(after[1].note, /Send it again/);
  assert.ok(!s.calls.some(([op]) => op === 'submit'), 'nothing was resent automatically'); stub.reply = (op) => (op === 'create' ? { session_id: 'rt1', stored_session_id: 'S1' } : op === 'attach' ? { session_id: 'rt1', running: false, messages: [] } : op === 'events.since' ? { events: [], latest_seq: 0, epoch: 'e' } : op === 'submit' ? { status: 'streaming', user_row_id: 5 } : {});
});

test('event mapping keeps session, turn, message and tool identities distinct and drops raw/unknown frames', () => {
  const s = { stored: 'S', turn: null, partial: '', running: false };
  const evs = [{ type: 'message.start' }, { type: 'tool.start', payload: { tool_id: 'call_9', name: 'web' } }, { type: 'message.delta', payload: { text: 'hi' } }, { type: 'tool.complete', payload: { tool_id: 'call_9', name: 'web', duration_s: 1.5, result: { secret: 'x' } } }, { type: 'message.complete', payload: { text: 'hi', status: 'complete' } }, { type: 'terminal.output', payload: { text: 'nope' } }].map((e) => normalise(e, s));
  assert.deepEqual(evs.map((e) => e?.type), ['turn.start', 'tool.start', 'message.delta', 'tool.end', 'turn.end', undefined]);
  assert.ok(evs[1].turn_id === evs[4].turn_id && evs[1].tool_id === 'call_9' && evs[0].session_id === 'S'); assert.ok(!JSON.stringify(evs[3]).includes('secret'), 'tool results are not forwarded');
});
