// 0.4.2 vc31 audit N1-N3 (Soran): the connector's /model confirm after a restart, UI_OPS.setmodel's request shape, and a tool-made
// file listed twice in a non-streaming native reply. Fake gateway only where it must be (it mirrors Hermes validate_action and the
// selection-guard token at pin f9bdaa30); the unit tests stub the gateway's rpc and read the exact wire params.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor, runConnector } from './machine-helpers.js';
import { setup, REAL } from './ui-helpers.js';
import { UI_OPS, HermesGateway } from '../../connector/foxfleet-connector.mjs';
import { nativeFacade } from '../native-facade.js';
import { nativeHub } from '../hermes-ui.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A gateway whose rpc is recorded; `answers(method, params)` plays Hermes.
function stubGateway(answers) {
  const gw = new HermesGateway({ profile: 'p', home: '/x', launch: () => null, emit() {} }), wire = [];
  gw.ensure = async () => {}; gw.rpc = async (method, params) => { wire.push([method, structuredClone(params)]); return answers(method, params); };
  return { gw, wire, mutates: () => wire.filter(([m]) => m === 'session.mutate').map(([, p]) => p) };
}
const hermesModel = (method, p) => {
  if (method === 'session.activate') return { session_id: p.session_id, revision: 3, execution_generation: 1 };
  if (method !== 'session.mutate') return {};
  const pl = p.payload; // Hermes validate_action: every payload value a non-empty string
  if (Object.values(pl).some((v) => typeof v !== 'string' || !v.trim())) throw Object.assign(new Error('invalid_params'), { code: 'upstream', rpc: 4001 });
  if (/expensive/.test(pl.model) && pl.confirm !== 'tok-1') return { status: 'confirmation_required', confirm_required: true, confirm: 'tok-1', confirm_message: 'This model is expensive.' };
  return { status: 'ok', model: pl.model };
};

// ---------- N3: UI_OPS.setmodel builds the request Hermes takes ----------
test('N3: UI_OPS.setmodel builds a well-formed session.mutate (operation model, payload {model, provider}), never {value}', () => {
  const [m, p] = UI_OPS.setmodel({ value: 'gpt-x --provider openrouter', session_id: 'rt1', confirm: true, evil: 1 });
  assert.equal(m, 'session.mutate');
  assert.deepEqual(p, { session_id: 'rt1', operation: 'model', payload: { model: 'gpt-x', provider: 'openrouter' } }, 'confirm and the fence are added by setModel only');
  assert.deepEqual(UI_OPS.setmodel({ value: '  claude-y  ', session_id: 'rt1' })[1].payload, { model: 'claude-y' }, 'no provider key when none was named');
  assert.throws(() => UI_OPS.setmodel({ value: '--provider x', session_id: 'rt1' }), (e) => e.code === 'bad_params', 'a provider alone is not a model');
  assert.throws(() => UI_OPS.setmodel({ value: 'gpt-x --global', session_id: 'rt1' }), (e) => e.code === 'not_allowed');
  assert.throws(() => UI_OPS.setmodel({ value: 'gpt-x' }), (e) => e.code === 'bad_params');
});

test('N3: setModel sends exactly the UI_OPS.setmodel request plus the revision fence and a request id', async () => {
  const { gw, mutates } = stubGateway(hermesModel);
  const r = await gw.call('setmodel', { value: 'gpt-x --provider openrouter', session_id: 'rt1' }); assert.equal(r.value, 'gpt-x'); assert.equal(r.confirm_required, false);
  const [p] = mutates(), { request_id, ...rest } = p; assert.match(request_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(rest, { ...UI_OPS.setmodel({ value: 'gpt-x --provider openrouter', session_id: 'rt1' })[1], expected_revision: 3, expected_generation: 1 });
});

// ---------- N2: a confirm with no pending prompt (connector restarted) asks again instead of sending confirm:true ----------
test('N2: confirm with no stored token (fresh connector) omits confirm, so Hermes re-asks; the second confirm carries the token', async () => {
  const { gw, mutates } = stubGateway(hermesModel); // a connector that never saw the refusal = one that restarted after it
  const again = await gw.call('setmodel', { value: 'expensive-1', session_id: 'rt1', confirm: true });
  assert.equal(again.confirm_required, true, 'the user is asked again, nothing switched'); assert.match(again.confirm_message, /expensive/);
  assert.equal('confirm' in mutates()[0].payload, false, 'no boolean confirm on the wire (Hermes refuses it as invalid_params)');
  const ok = await gw.call('setmodel', { value: 'expensive-1', session_id: 'rt1', confirm: true });
  assert.equal(ok.confirm_required, false); assert.equal(mutates()[1].payload.confirm, 'tok-1', 'the re-issued token is used on the re-confirm');
});

test('N2: a token is kept only per runtime session and only as Hermes sent it; a gateway restart forgets them', async () => {
  const { gw, mutates } = stubGateway((m, p) => (m === 'session.mutate' && p.session_id === 'rt9' ? { status: 'confirmation_required', confirm: true, confirm_message: 'odd' } : hermesModel(m, p)));
  await gw.call('setmodel', { value: 'expensive-1', session_id: 'rt9' }); // a non-string token is never stored or echoed
  await gw.call('setmodel', { value: 'expensive-1', session_id: 'rt9', confirm: true }); assert.equal('confirm' in mutates()[1].payload, false);
  await gw.call('setmodel', { value: 'expensive-1', session_id: 'rt1' });
  await gw.call('setmodel', { value: 'expensive-1', session_id: 'rt2', confirm: true }); assert.equal('confirm' in mutates()[3].payload, false, "another session's token is not used");
  gw.state = 'ready'; gw.exited(0); // the Hermes gateway process died: its runtime sessions (and their prompts) are gone
  await gw.call('setmodel', { value: 'expensive-1', session_id: 'rt1', confirm: true }); assert.equal('confirm' in mutates()[4].payload, false, 'no token survives the gateway restart');
});

test('N2 end to end: the connector restarts between the expensive-model prompt and the confirm; the confirm re-asks, then switches', async (t) => {
  if (REAL) return t.skip('needs a guarded model on the fake gateway');
  const x = await setup(t), json = async (route, data) => { const r = await fetch(x.base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await waitFor(async () => { const a = (await json('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  const A = '/api/agents/default/native', sid = (await json(`${A}/sessions`, {})).body.session_id, url = `${A}/sessions/${sid}/model`;
  assert.equal((await json(`${A}/sessions/${sid}/messages`, { text: 'hello' })).status, 202); // the model is per conversation: the chat has a turn, so Hermes has stored it
  assert.ok(await waitFor(async () => (await json(`${A}/sessions/${sid}/attach`, {})).body.running === false, { tries: 100, ms: 100 }), 'the first turn finished');
  const first = await json(url, { model: 'expensive-1' }); assert.equal(first.status, 200); assert.equal(first.body.confirm_required, true);
  x.run.p.kill(); await x.run.done; // connector (and its gateway) restart: the pending prompt's token lived only in that process
  const online = async () => (await json('/api/machines')).body.machines.some((m) => m.id === x.machine.id && m.online);
  assert.ok(await waitFor(async () => !(await online()), { tries: 100, ms: 100 }), 'the machine went offline');
  const again = runConnector(t, ['run'], { hermes: x.root, configDir: x.cfgDir });
  assert.ok(await waitFor(async () => { if (!(await online())) return 0; const u = x.server.connectors.ui(x.machine.id); return u && u.caps('default')?.native ? 1 : 0; }, { tries: 150, ms: 100 }), again.out);
  const confirm = await json(url, { model: 'expensive-1', confirm: true });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.body)); assert.equal(confirm.body.confirm_required, true, 'asked again, not an error and not switched');
  const ok = await json(url, { model: 'expensive-1', confirm: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.confirm_required, undefined); assert.equal(ok.body.model, 'expensive-1');
});

test('N2 hub: /model on a runtime id from a gateway that restarted (4007) re-attaches once and sends again; other errors are not retried', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-cm-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  let live = 'rt1', fail = null; const calls = [];
  const ui = { caps: () => ({ native: true }), subscribe() {}, call: async (agent, op, p) => {
    calls.push([op, p?.session_id ?? p?.stored_session_id]);
    if (op === 'create') return { session_id: 'rt1', stored_session_id: 'S1' };
    if (op === 'attach') return { session_id: live, running: false, messages: [] };
    if (op === 'events.since') return { events: [], latest_seq: 0, epoch: 'e2' };
    if (op === 'setmodel') { if (fail) throw fail; if (p.session_id !== live) throw Object.assign(new Error('session not found'), { code: 'upstream', rpc: 4007 }); return { value: 'expensive-1', scope: 'session', confirm_required: true, confirm_message: 'again' }; }
    return {};
  } };
  const hub = await nativeHub({ connectors: { ui: () => ui }, file: path.join(dir, 'j.json') }); await hub.create('u', 'M1', 'p');
  live = 'rt7'; // the connector restarted: Hermes resumes S1 under a new runtime id, the hub still holds rt1
  const r = await hub.setModel('u', 'M1', 'p', 'S1', 'expensive-1', true);
  assert.equal(r.confirm_required, true); assert.deepEqual(calls.slice(1).map(([op, id]) => `${op}:${id}`), ['setmodel:rt1', 'attach:S1', 'events.since:rt7', 'setmodel:rt7']);
  fail = Object.assign(new Error('invalid_params'), { code: 'upstream', rpc: 4001 }); calls.length = 0;
  await assert.rejects(hub.setModel('u', 'M1', 'p', 'S1', 'x', false), (e) => e.rpc === 4001); assert.deepEqual(calls.map(([op]) => op), ['setmodel'], 'only a dead runtime id is retried');
});

// ---------- N1: streaming off, a tool-made file is in the reply once ----------
async function chat(x, content) {
  const r = await fetch(`${x.base}/api/agents/default/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
  let text = ''; for (const m of (await r.text()).matchAll(/^data: (\{.*\})$/gm)) { try { text += JSON.parse(m[1]).choices?.[0]?.delta?.content ?? ''; } catch { /* other frames */ } }
  return { status: r.status, text, sid: r.headers.get('x-hermes-session-id') };
}
const refs = (s) => [...s.matchAll(/MEDIA:(\S+)/g)].map((m) => m[1]);
async function nativeReady(t) {
  const x = await setup(t); await waitFor(async () => { const a = (await (await fetch(x.base + '/api/agents')).json()).agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; }); return x;
}

test('N1: streaming off, a tool-made file is listed once in the reply (it was twice: tool.end and message.complete)', async (t) => {
  if (REAL) return t.skip('fake gateway prompts');
  const x = await nativeReady(t);
  const one = await chat(x, 'nostream mediacase'); assert.equal(one.status, 200);
  assert.deepEqual(refs(one.text), ['/tmp/fake/chart.png'], JSON.stringify(one.text)); assert.match(one.text, /Finished reply without streaming\./);
  const two = await chat(x, 'nostream mediacase2'); assert.deepEqual(refs(two.text).sort(), ['/tmp/fake/chart.png', '/tmp/fake/map.png'], 'two distinct files both stay, once each: ' + JSON.stringify(two.text));
  const streamed = await chat(x, 'mediacase'); assert.deepEqual(refs(streamed.text), ['/tmp/fake/chart.png'], 'streaming unchanged: ' + JSON.stringify(streamed.text));
});

test('N1: streaming off, the agent naming the tool file itself is not doubled, and a different file it names is kept', async (t) => {
  if (REAL) return t.skip('fake gateway prompts');
  const x = await nativeReady(t), r = await chat(x, 'nostream ownmedia mediacase');
  assert.deepEqual(refs(r.text).sort(), ['/tmp/fake/chart.png', '/tmp/fake/table.csv'], JSON.stringify(r.text)); assert.match(r.text, /Here is the chart\./); assert.match(r.text, /And a table: MEDIA:\/tmp\/fake\/table\.csv/);
});

test('N1 unit: only refs the run already delivered are dropped from the final text; other text and files are untouched', async () => {
  let started; const runs = { start: async ({ open }) => { started = await open(); return { id: 'r1', done: false }; } };
  let viewer; const nat = { isRunning: () => false, cursor: () => 0, attach: async () => {}, create: async () => ({ session_id: 's1' }), send: async () => ({ message: { ack: 'streaming' } }), follow: (scope, mid, prof, stored, from, h) => { viewer = h; return { events: [], unsubscribe() {} }; } };
  const f = nativeFacade({ runs }); await f.send(nat, { scope: 'u', m: { name: 'a', machineId: 'm', profile: 'p' }, session: 's1', text: 'hi' });
  const body = started.body.getReader(), dec = new TextDecoder(); let out = '';
  viewer({ type: 'tool.end', turn_id: 't', tool_id: 'x', name: 'image_generate', media: [{ ref: '/tmp/a.png' }] });
  viewer({ type: 'turn.end', status: 'complete', text: 'See MEDIA:/tmp/a.png inline.\nMEDIA:/tmp/b.png\n\nMEDIA:/tmp/a.png\n  MEDIA:/tmp/a.png  \nMEDIA:/tmp/a.png.bak' });
  for (;;) { const { value, done } = await body.read(); if (done) break; out += dec.decode(value); }
  let text = ''; for (const m of out.matchAll(/^data: (\{.*\})$/gm)) text += JSON.parse(m[1]).choices?.[0]?.delta?.content ?? '';
  assert.equal(text, '\n\nMEDIA:/tmp/a.png\nSee MEDIA:/tmp/a.png inline.\nMEDIA:/tmp/b.png\n\nMEDIA:/tmp/a.png.bak', JSON.stringify(text));
});
