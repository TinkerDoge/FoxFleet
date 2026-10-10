// Native Hermes UI gateway through the REAL connector and the hub's tunnel. Fake gateway by default (protocol-faithful, see fake-gateway.mjs);
// set HERMES_REAL_GATEWAY_TEST='{"cmd":["/path/python","-m","tui_gateway.entry"],"cwd":"/path/hermes-agent","config":"<yaml>"}' to run the same scenario against a
// real Hermes gateway (that run is what design/notes/hermes-ui-gateway.md was verified with).
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './machine-helpers.js';
import { setup, REAL } from './ui-helpers.js';

const sess = (x, rt) => x.events.filter((e) => e.kind === 'event' && e.session_id === rt);

test('capability probe: native UI gateway is advertised only when a gateway command exists', async (t) => {
  const on = await setup(t); await waitFor(async () => on.ui.caps('default'), { tries: 200, ms: 100 });
  assert.equal(on.ui.caps('default').native, true); assert.equal(on.ui.caps('default').protocol, 'tui-gateway-jsonrpc');
  assert.ok(on.ui.caps('default').ops.includes('submit') && !on.ui.caps('default').ops.includes('cli.exec'));
  const off = await setup(t, { gateway: false }); await waitFor(async () => off.ui.caps('default'), { tries: 200, ms: 100 });
  assert.equal(off.ui.caps('default').native, false); await assert.rejects(off.ui.call('default', 'info'), (e) => e.code === 'unavailable');
});

test('allowlist: only named actions cross the tunnel, params are rebuilt, text and dispatch targets are validated', async (t) => {
  const x = await setup(t); await x.ui.call(x.agent, 'info');
  for (const op of ['cli.exec', 'config.set', 'session.close', 'reload.env', 'rpc', '__proto__']) await assert.rejects(x.ui.call(x.agent, op, { session_id: 'a', command: 'rm -rf /' }), (e) => e.code === 'not_allowed', op);
  await assert.rejects(x.ui.call(x.agent, 'dispatch', { name: '/cli', session_id: 'a' }), (e) => e.code === 'not_allowed');
  await assert.rejects(x.ui.call(x.agent, 'submit', { session_id: 'a', text: '   ' }), (e) => e.code === 'bad_params');
  await assert.rejects(x.ui.call(x.agent, 'submit', { session_id: 'a', text: 'x'.repeat(100_001) }), (e) => e.code === 'bad_params');
  const c = await x.ui.call(x.agent, 'create', { cols: 9999, evil: 1 }); assert.ok(c.session_id && c.stored_session_id);
  if (!REAL) assert.equal((await x.ui.call(x.agent, 'dispatch', { name: '/compress', session_id: c.session_id })).type, 'exec'); // the real gateway needs a built agent for /compress
  await assert.rejects(x.ui.call(x.agent, 'dispatch', { name: '/model', arg: 'x', session_id: c.session_id }), (e) => e.code === 'not_allowed', '/model is config.set, not dispatch');
  const sm = await x.ui.call(x.agent, 'setmodel', { value: 'fake-model', session_id: c.session_id }); assert.equal(sm.value, 'fake-model'); assert.equal(sm.scope, 'session');
  await assert.rejects(x.ui.call(x.agent, 'setmodel', { value: 'fake-model --global', session_id: c.session_id }), (e) => e.code === 'not_allowed', 'profile defaults are not changed remotely');
  assert.equal((await x.ui.call(x.agent, 'busy', { mode: 'status' })).value.length > 0, true); await assert.rejects(x.ui.call(x.agent, 'busy', { mode: 'rm' }), (e) => e.code === 'bad_params');
  assert.match((await x.ui.call(x.agent, 'catalog')).pairs[0][0], /^\//); assert.equal((await x.ui.call(x.agent, 'resolve', { name: 'busy' })).canonical, 'busy');
  assert.ok((await x.ui.call(x.agent, 'models', {})).providers.length > 0);
  await assert.rejects(x.ui.call('ghost', 'info'), (e) => e.code === 'unavailable', 'a profile that is not shared has no gateway');
});

test('native session: create, submit, correction during work, queue, reattach to the same owner, interrupt, gateway drains its own queue', async (t) => {
  const x = await setup(t), { ui, agent } = x;
  const c = await ui.call(agent, 'create', {}); const rt = c.session_id, stored = c.stored_session_id;
  assert.equal((await ui.call(agent, 'submit', { session_id: rt, text: 'slow story' })).status, 'streaming');
  assert.ok(await x.until((e) => e.type === 'message.delta' && e.session_id === rt));
  const steer = await ui.call(agent, 'steer', { session_id: rt, text: 'make it about foxes' }); assert.equal(steer.status, 'queued', 'actual ack, not a prediction: Hermes says queued, not consumed');
  assert.ok(['rejected', 'redirected', 'queued'].includes((await ui.call(agent, 'redirect', { session_id: rt, text: 'owls' })).status), 'redirect reports Hermes\'s own status (rejected when the model route cannot redirect)');
  assert.equal((await ui.call(agent, 'submit', { session_id: rt, text: 'then say bye', queued: true })).status, 'queued');
  // a second device attaches: same runtime owner, snapshot restores partial answer + queued
  const a = await ui.call(agent, 'attach', { stored_session_id: stored });
  assert.equal(a.session_id, rt, 'reattach activates the existing owner and never starts another agent'); assert.equal(a.running, true);
  assert.equal(a.inflight.user, 'slow story'); assert.ok(a.inflight.assistant.length > 0, 'partial answer restored'); assert.equal(a.queued.user, 'then say bye');
  const b = await ui.call(agent, 'attach', { stored_session_id: stored }); assert.equal(b.session_id, rt);
  assert.equal(sess(x, rt).filter((e) => e.type === 'message.start').length, 1, 'attaching twice did not launch a turn');
  assert.equal((await ui.call(agent, 'interrupt', { session_id: rt })).status, 'interrupted');
  assert.ok(await x.until((e) => e.type === 'message.complete' && e.session_id === rt && /interrupted|complete/.test(e.payload?.status ?? 'complete')));
  assert.ok(await x.until((e) => e.type === 'message.start' && e.session_id === rt && e.seq > 2 && sess(x, rt).filter((y) => y.type === 'message.start').length >= 2), 'Hermes itself starts the queued turn: the hub does not');
  const since = await ui.call(agent, 'events.since', { session_id: rt, last_seen: 0 }); assert.ok(since.events.length > 3 && since.latest_seq >= since.events.at(-1).seq && since.truncated === false);
});

test('clarification: request arrives with its own id, answered once, returns after reattach, cancelled by id on interrupt', async (t) => {
  const x = await setup(t), { ui, agent } = x;
  const c = await ui.call(agent, 'create', {}), rt = c.session_id;
  await ui.call(agent, 'submit', { session_id: rt, text: 'please clarify env' });
  const req = await x.until((e) => e.kind === 'request' && e.params.session_id === rt); assert.ok(req, 'request surfaced'); assert.equal(req.method, 'clarify'); assert.match(req.id, /^srq-/); assert.equal(req.params.questions[0].qid, 'q0');
  const a = await ui.call(agent, 'attach', { stored_session_id: c.stored_session_id }); assert.equal(a.open_requests.length, 1, 'the open question returns after reconnect'); assert.equal(a.open_requests[0].id, req.id);
  assert.deepEqual(await ui.call(agent, 'respond', { id: req.id, result: { answers: { q0: 'staging' } } }), { ok: true });
  await assert.rejects(ui.call(agent, 'respond', { id: req.id, result: { answers: { q0: 'production' } } }), (e) => e.code === 'gone', 'respond once by id');
  assert.ok(await x.until((e) => e.type === 'message.complete' && e.session_id === rt));
  await ui.call(agent, 'submit', { session_id: rt, text: 'clarify again' });
  const second = await x.until((e) => e.kind === 'request' && e.id !== req.id); assert.ok(second);
  await ui.call(agent, 'interrupt', { session_id: rt });
  const cancel = await x.until((e) => e.type === 'request.cancel' && e.payload.id === second.id); assert.ok(cancel, 'request.cancel names the id'); assert.equal(cancel.payload.reason, 'interrupted');
  await assert.rejects(ui.call(agent, 'respond', { id: second.id, result: {} }), (e) => e.code === 'gone');
});

test('reconnect: hub link drops mid-turn, the connector keeps the owner, reattach does not duplicate the turn', async (t) => {
  const x = await setup(t), { agent } = x; let ui = x.ui;
  const c = await ui.call(agent, 'create', {}), rt = c.session_id; await ui.call(agent, 'submit', { session_id: rt, text: 'slow story' });
  assert.ok(await x.until((e) => e.type === 'message.delta' && e.session_id === rt));
  x.server.connectors.drop(x.machine.id);
  ui = await waitFor(async () => { const u = x.server.connectors.ui(x.machine.id); return u && u !== x.ui ? u : null; }, { tries: 80, ms: 150 }); assert.ok(ui, 'connector reconnects by itself');
  const events = []; ui.subscribe((ag, ev) => events.push(ev));
  const a = await ui.call(agent, 'attach', { stored_session_id: c.stored_session_id });
  assert.equal(a.session_id, rt); assert.equal(a.running, true, 'the turn kept running while nobody was attached');
  assert.equal(x.events.filter((e) => e.type === 'message.start' && e.session_id === rt).length + events.filter((e) => e.type === 'message.start').length, 1, 'no duplicate turn');
  await ui.call(agent, 'interrupt', { session_id: rt });
});

test('gateway crash: pending calls fail, open requests are reported withdrawn, the next call restarts it and old runtime ids are gone', async (t) => {
  const x = await setup(t); if (REAL) return t.skip('crash needs the fake gateway');
  const { ui, agent } = x, c = await ui.call(agent, 'create', {}), rt = c.session_id;
  await ui.call(agent, 'submit', { session_id: rt, text: 'crash now' });
  const down = await x.until((e) => e.kind === 'gateway.down'); assert.ok(down); assert.equal(down.code, 7);
  await assert.rejects(ui.call(agent, 'interrupt', { session_id: rt }), (e) => ['gateway_down', 'upstream', 'timeout'].includes(e.code) || /not running|did not become ready|stopped/.test(e.message));
  const info = await ui.call(agent, 'info', {}, 35_000); assert.equal(info.ready, true);
  await assert.rejects(ui.call(agent, 'attach', { stored_session_id: c.stored_session_id }), (e) => e.rpc === 4007, 'a restarted owner does not know the old session (the hub journal must reconcile)');
});
