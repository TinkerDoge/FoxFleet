// 0.4.1 step detail (docs/LIVE-EVENTS.md "Step detail" and "Model picker"): reasoning.available on /v1/runs, the tool lifecycle
// (ok, duration, clipped previews), foxfleet.step from message.interim / status.update / subagent, live v2 typing label and the
// ephemeral run.step, message.new reasoning/tools, the model list and per-chat model override, and byte compatibility of old frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalise } from '../hermes-runs.js';
import { toFrames } from '../native-facade.js';
import { normalise as uiNormalise } from '../hermes-ui.js';
import { messageExtras, argsPreview, toolOutcome } from '../steps.js';
import { fakeNative, NATIVE_FEATURES } from './native-hermes.js';
import { hub, hermes, sse, until, sleep } from './live2-helpers.js';
import { setup } from './ui-helpers.js';
import { waitFor } from './machine-helpers.js';
import { readFileSync } from 'node:fs';
import { validate } from '../../contract/validate.mjs';

const spec = JSON.parse(readFileSync(new URL('../../contract/openapi.json', import.meta.url), 'utf8'));
const check = (name, value, what = name) => { const errs = validate({ $ref: `#/components/schemas/${name}` }, value, spec); assert.deepEqual(errs, [], `${what}: ${errs.join('; ')}`); };
const frameData = (text, event) => [...text.matchAll(new RegExp(`^event: ${event.replace('.', '\\.')}\ndata: (.*)$`, 'gm'))].map((m) => JSON.parse(m[1]));

const dec = new TextDecoder();
const run = (events) => { const link = {}; return { link, out: events.flatMap(([type, data]) => normalise({ ...data, type }, type, link).map((f) => dec.decode(f))) }; };
const parse = (raw) => ({ event: /^event: (.*)$/m.exec(raw)?.[1] ?? null, data: JSON.parse(/^data: (.*)$/m.exec(raw)[1]) });

test('/v1/runs: reasoning.available only when no reasoning delta streamed, never duplicated', () => {
  const a = run([['reasoning.available', { text: 'whole thought' }], ['message.delta', { delta: 'hi' }]]);
  assert.deepEqual(a.out, ['data: {"choices":[{"delta":{"reasoning_content":"whole thought"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']);
  const b = run([['reasoning.delta', { delta: 'step 1' }], ['reasoning.available', { text: 'step 1' }], ['message.delta', { delta: 'ok' }]]);
  assert.equal(b.out.filter((f) => f.includes('reasoning_content')).length, 1, 'the streamed reasoning is not repeated');
  const c = run([['reasoning.available', { text: 'first' }], ['tool.started', { tool: 'x' }], ['reasoning.available', { text: 'second' }]]);
  assert.deepEqual(c.out.filter((f) => f.includes('reasoning_content')).map((f) => parse(f).data.choices[0].delta.reasoning_content), ['first', '\n\nsecond'], 'later steps of the same run add to it');
  assert.deepEqual(run([['reasoning.available', { text: '   ' }]]).out, [], 'empty reasoning is dropped');
});

test('/v1/runs: tool lifecycle: hermes.tool.progress on start only, foxfleet.tool start/end with ok, duration_ms, clipped previews, pairing', () => {
  const long = 'echo ' + 'z'.repeat(400);
  const { out } = run([['tool.started', { tool: 'terminal', preview: 'ls -la /tmp' }], ['tool.started', { tool: 'terminal', preview: long }], ['tool.completed', { tool: 'terminal', duration: 1.2345, error: false, result: 'r'.repeat(800) }],
    ['tool.completed', { tool: 'terminal', duration: 0.5, error: true }], ['tool.started', { tool: 'web', tool_call_id: 'call_7' }], ['tool.failed', { tool: 'web', tool_call_id: 'call_7' }], ['tool.output', { tool: 'web' }]]);
  const f = out.map(parse);
  assert.equal(out[0], 'event: hermes.tool.progress\ndata: {"tool":"terminal"}\n\n', 'the start frame is byte-identical to 0.4.0');
  assert.deepEqual(f.filter((x) => x.event === 'hermes.tool.progress').map((x) => x.data), [{ tool: 'terminal' }, { tool: 'terminal' }, { tool: 'web' }], 'never on completion');
  const tools = f.filter((x) => x.event === 'foxfleet.tool').map((x) => x.data);
  assert.deepEqual(tools[0], { type: 'tool.start', tool_id: 't1', name: 'terminal', preview: 'ls -la /tmp' });
  assert.equal(tools[1].preview.length, 201); assert.ok(tools[1].preview.endsWith('…'), 'args preview clipped to 200 + …');
  assert.deepEqual({ ...tools[2], result_preview: tools[2].result_preview.length }, { type: 'tool.end', tool_id: 't1', name: 'terminal', ok: true, duration_ms: 1235, result_preview: 501 }, 'paired with the oldest open call; result clipped to 500 + …');
  assert.deepEqual(tools[3], { type: 'tool.end', tool_id: 't2', name: 'terminal', ok: false, duration_ms: 500 });
  assert.deepEqual(tools[4], { type: 'tool.start', tool_id: 'call_7', name: 'web' }, 'an upstream call id is kept');
  assert.deepEqual(tools[5], { type: 'tool.end', tool_id: 'call_7', name: 'web', ok: false });
  assert.deepEqual(tools[6], { type: 'tool.progress', tool_id: '', name: 'web' }, 'other ticks: lifecycle only');
});

test('/v1/runs: step events from message.interim (not when already streamed), status and subagent', () => {
  const { out } = run([['message.interim', { text: 'Let me   check\nthe logs', already_streamed: false }], ['message.interim', { text: 'streamed already', already_streamed: true }], ['subagent.start', { goal: 'research prices' }], ['subagent.complete', { status: 'failed', summary: 'no access' }], ['subagent.complete', { status: 'completed', summary: 'x'.repeat(400) }]]);
  const f = out.map(parse);
  assert.deepEqual(f.filter((x) => x.event === 'hermes.tool.progress').map((x) => x.data.tool), ['Let me check the logs', 'streamed already'], 'the 0.4.0 commentary frame stays');
  const steps = f.filter((x) => x.event === 'foxfleet.step').map((x) => x.data);
  assert.deepEqual(steps.slice(0, 3), [{ kind: 'commentary', text: 'Let me check the logs', level: 'info' }, { kind: 'subagent', text: 'Subagent started: research prices', level: 'info' }, { kind: 'subagent', text: 'Subagent failed: no access', level: 'error' }]);
  assert.equal(steps[3].text.length, 301); assert.equal(steps.length, 4);
  // native: status.update -> foxfleet.step status; message.interim -> commentary (+ the commentary progress frame)
  const s = { stored: 'S', turn: 't_1' };
  assert.deepEqual(toFrames(uiNormalise({ type: 'status.update', payload: { kind: 'warn', text: 'Context is long' } }, s)).map((x) => dec.decode(x)), ['event: foxfleet.step\ndata: {"kind":"status","turn_id":"t_1","text":"Context is long","level":"warn"}\n\n']);
  assert.deepEqual(toFrames(uiNormalise({ type: 'message.interim', payload: { text: 'Looking', already_streamed: false } }, s)).map((x) => dec.decode(x)), ['event: hermes.tool.progress\ndata: {"tool":"Looking"}\n\n', 'event: foxfleet.step\ndata: {"kind":"commentary","turn_id":"t_1","text":"Looking","level":"info"}\n\n']);
  assert.equal(uiNormalise({ type: 'message.interim', payload: { text: 'x', already_streamed: true } }, s), null);
});

test('existing run-stream frames are byte-compatible (deltas, terminal, native tool frames without the new data)', () => {
  const { out, link } = run([['message.delta', { delta: 'a' }], ['reasoning.delta', { delta: 'b' }], ['run.completed', { output: 'a' }]]);
  assert.deepEqual(out, ['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"choices":[{"delta":{"reasoning_content":"b"}}]}\n\n']); assert.equal(link.terminal, 'completed');
  assert.deepEqual(toFrames({ type: 'tool.start', turn_id: 't', tool_id: 'c', name: 'n' }).map((x) => dec.decode(x)), ['event: hermes.tool.progress\ndata: {"tool":"n"}\n\n', 'event: foxfleet.tool\ndata: {"type":"tool.start","turn_id":"t","tool_id":"c","name":"n"}\n\n']);
  assert.deepEqual(toFrames({ type: 'tool.end', turn_id: 't', tool_id: 'c', name: 'n' }).map((x) => dec.decode(x)), ['event: foxfleet.tool\ndata: {"type":"tool.end","turn_id":"t","tool_id":"c","name":"n"}\n\n']);
  assert.deepEqual(toFrames({ type: 'message.delta', text: 'x' }).map((x) => dec.decode(x)), ['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
});

test('message extras match the history shape and clipping', () => {
  assert.deepEqual(messageExtras({}), {}); assert.deepEqual(messageExtras({ reasoning: '  ', tools: [] }), {});
  const x = messageExtras({ reasoning: 'é'.repeat(40_000), tools: [...Array(60)].map((_, i) => ({ id: 'x', name: i ? 'n' : 'n'.repeat(100), args: 'a'.repeat(600), result: 'r', ok: i % 2 === 0 })) });
  assert.equal(Buffer.byteLength(x.reasoning), 64 * 1024); assert.equal(x.reasoning_truncated, true);
  assert.equal(x.tools.length, 50); assert.deepEqual(Object.keys(x.tools[1]), ['name', 'args', 'result', 'ok']); assert.equal(x.tools[0].name.length, 81); assert.equal(x.tools[1].args.length, 501);
  assert.equal(argsPreview({}), ''); assert.equal(argsPreview('{"q":"a  b"}'), '{"q":"a b"}'); assert.deepEqual(toolOutcome({ success: false }), { ok: false, result_preview: '{"success":false}' });
});

const nativeRunsHub = async (t, extra = {}) => {
  const fake = fakeNative(), options = { providers: [{ slug: 'openrouter', name: 'OpenRouter', is_current: true, models: ['a/b', { id: 'c/d' }] }] }, seen = [];
  const { mock, opts } = await hermes(t, { features: NATIVE_FEATURES, apiRoute: async (req, res, route, u) => {
    if (route === '/api/model/options') { seen.push(u.search); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(options)); return true; }
    return (await fake.route(req, res, route, u)) !== false;
  }, ...extra });
  const h = await hub(t); assert.equal((await h.call('/api/connections', { ...mock.connection, name: 'atlas' })).status, 201);
  return { fake, mock, opts, seen, ...h };
};
const send = (call, text, session = 'sess-1') => call('/api/agents/atlas/messages', { messages: [{ role: 'user', content: text }], session_id: session });

test('live v2 on /v1/runs: typing label and tool_id, ephemeral run.step (never stored or replayed), message.new reasoning/tools; v1 unchanged', async (t) => {
  const { fake, call, base } = await nativeRunsHub(t);
  const snap = await call('/api/chats'), cursor = encodeURIComponent(snap.body.cursor);
  const s = sse(t, `${base}/api/live/stream?v=2&since=${cursor}`), v1 = sse(t, `${base}/api/live/stream`); await s.wait((f) => f.event === 'foxfleet.ready'); await v1.wait((f) => f.event === 'foxfleet.ready');
  const r = await send(call, 'do it'); assert.equal(r.status, 202, JSON.stringify(r.body));
  const id = await until(() => fake.last()), run0 = r.body.run_id;
  fake.emit(id, 'message.interim', { text: 'Checking first', already_streamed: false });
  fake.emit(id, 'tool.started', { tool: 'terminal', preview: 'ls -la /tmp' });
  const typing = await s.wait((f) => f.event === 'typing' && f.data.label === 'ls -la /tmp');
  assert.deepEqual(typing.data, { agent: 'atlas', chat: 'sess-1', state: 'tool', tool: 'terminal', label: 'ls -la /tmp', tool_id: 't1', ttl_ms: 6000 }); assert.equal(typing.id, null);
  const commentaryTyping = s.frames.find((f) => f.event === 'typing' && f.data.label === 'Checking first'); assert.ok(commentaryTyping, 'commentary labels the typing frame'); assert.equal(commentaryTyping.data.tool_id, undefined);
  fake.emit(id, 'tool.completed', { tool: 'terminal', duration: 0.25, error: false, result: 'q'.repeat(700) });
  fake.emit(id, 'subagent.start', { goal: 'dig' });
  fake.emit(id, 'reasoning.available', { text: 'I thought' });
  fake.emit(id, 'message.delta', { delta: 'all done' });
  await s.wait((f) => f.event === 'typing' && f.data.state === 'typing');
  fake.finish(id, 'run.completed', { output: 'all done' });
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  assert.equal(reply.data.message.text, 'all done'); assert.equal(reply.data.message.reasoning, 'I thought');
  assert.deepEqual(reply.data.message.tools, [{ name: 'terminal', args: 'ls -la /tmp', result: 'q'.repeat(500) + '…', ok: true }], 'history shape { name, args, result, ok }, result clipped');
  await s.wait((f) => f.event === 'run.finished');
  const steps = s.frames.filter((f) => f.event === 'run.step');
  assert.deepEqual(steps.map((f) => ({ ...f.data, at: 0 })), [
    { agent: 'atlas', chat: 'sess-1', run_id: run0, kind: 'commentary', text: 'Checking first', at: 0 },
    { agent: 'atlas', chat: 'sess-1', run_id: run0, kind: 'tool.start', tool_id: 't1', name: 'terminal', preview: 'ls -la /tmp', at: 0 },
    { agent: 'atlas', chat: 'sess-1', run_id: run0, kind: 'tool.end', tool_id: 't1', name: 'terminal', ok: true, duration_ms: 250, preview: 'q'.repeat(500) + '…', at: 0 },
    { agent: 'atlas', chat: 'sess-1', run_id: run0, kind: 'status', text: 'Subagent started: dig', at: 0 }]);
  assert.ok(steps.every((f) => f.id === null && f.data.seq === undefined), 'run.step has no id and no seq');
  await s.wait((f) => f.event === 'typing' && f.data.state === 'idle');
  assert.deepEqual(Object.keys(s.frames.filter((f) => f.event === 'typing').at(-1).data), ['agent', 'chat', 'state', 'tool', 'ttl_ms'], 'idle typing frame keeps the 0.4.0 shape');
  // not stored: the pull endpoint and a replay from the same cursor carry no run.step / typing
  const pulled = await call(`/api/live/events?since=${cursor}`); assert.equal(pulled.status, 200);
  const types = pulled.body.events.map((e) => e.type); assert.ok(types.includes('message.new') && !types.includes('run.step') && !types.includes('typing'), types.join());
  const again = sse(t, `${base}/api/live/stream?v=2&since=${cursor}`); await again.wait((f) => f.event === 'foxfleet.ready');
  assert.ok(again.frames.some((f) => f.event === 'message.new') && !again.frames.some((f) => f.event === 'run.step'), 'never replayed');
  await v1.wait((f) => f.event === 'live' && f.data.type === 'run_finished');
  assert.ok(!v1.frames.some((f) => f.event === 'run.step' || f.event === 'typing' || f.raw.includes('message.new')), 'v1 carries no v2 frames');
  // the run stream itself: lifecycle frames for the client that watches the run
  const text = await (await fetch(`${base}/api/agents/atlas/runs/${run0}/events`)).text();
  assert.match(text, /event: foxfleet\.tool\ndata: \{"type":"tool\.end","tool_id":"t1","name":"terminal","ok":true,"duration_ms":250,"result_preview":"q{500}…"\}/);
  assert.match(text, /event: foxfleet\.step\ndata: \{"kind":"commentary","text":"Checking first","level":"info"\}/);
  assert.equal((text.match(/event: hermes\.tool\.progress\ndata: \{"tool":"terminal"\}/g) ?? []).length, 1, 'hermes.tool.progress once per tool, on start');
  for (const f of s.frames.filter((y) => y.event === 'typing')) check('TypingEvent', f.data);
  for (const f of steps) check('RunStepEvent', f.data);
  check('LiveEvent', reply.data, 'message.new with reasoning/tools');
  for (const d of frameData(text, 'foxfleet.tool')) check('RunToolFrame', d); for (const d of frameData(text, 'foxfleet.step')) check('RunStepFrame', d);
  assert.ok(frameData(text, 'foxfleet.tool').length === 2 && frameData(text, 'foxfleet.step').length === 2);
});

test('chat completions: hermes.tool.progress with a label becomes typing label, run.step tool.start and a message.new tool', async (t) => {
  const frames = ['data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n', 'event: hermes.tool.progress\ndata: {"tool":"terminal","emoji":"💻","label":"git status"}\n\n', 'data: {"choices":[{"delta":{"content":"clean"}}]}\n\n'];
  const { mock } = await hermes(t, { streamFrames: frames, streamDelayMs: 20, messages: [] }); const { call, base } = await hub(t);
  await call('/api/connections', { ...mock.connection, name: 'atlas' });
  const s = sse(t, `${base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  assert.equal((await send(call, 'status?')).status, 202);
  const ty = await s.wait((f) => f.event === 'typing' && f.data.state === 'tool'); assert.equal(ty.data.label, 'git status'); assert.equal(ty.data.tool, 'terminal');
  const step = await s.wait((f) => f.event === 'run.step'); assert.equal(step.data.kind, 'tool.start'); assert.equal(step.data.name, 'terminal'); assert.equal(step.data.preview, 'git status');
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  assert.equal(reply.data.message.reasoning, 'hmm'); assert.deepEqual(reply.data.message.tools, [{ name: 'terminal', args: 'git status' }]);
});

test('models: GET /api/agents/{name}/models for HTTP agents, capabilities.models, per-chat override sent on /v1/runs and cleared', async (t) => {
  const { fake, call, seen } = await nativeRunsHub(t);
  const agent = (await call('/api/agents/atlas')).body.agent; assert.equal(agent.capabilities.models, 'request');
  const list = await call('/api/agents/atlas/models?refresh=1'); assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body, { mode: 'request', providers: [{ slug: 'openrouter', name: 'OpenRouter', current: true, models: ['a/b', 'c/d'] }] }); assert.deepEqual(seen, ['?refresh=1']);
  check('ModelList', list.body); check('Capabilities', agent.capabilities);
  const codes = spec.components.schemas.Error.properties.code.description; for (const c of ['models_unsupported', 'invalid_model']) assert.ok(codes.includes(c), c);
  for (const bad of [{ model: 5 }, { model: 'has space' }, { model: 'a/b', provider: 'x y' }, {}]) { const x = await call('/api/agents/atlas/sessions/sess-1/model', bad); assert.equal(x.status, 400, JSON.stringify(bad)); assert.equal(x.body.code, 'invalid_model'); }
  const set = await call('/api/agents/atlas/sessions/sess-1/model', { model: 'c/d', provider: 'openrouter' }); assert.equal(set.status, 200); assert.deepEqual(set.body, { session_id: 'sess-1', model: 'c/d', provider: 'openrouter' }); check('ModelOverride', set.body);
  check('ModelList', (await call('/api/agents/atlas/models?session_id=sess-1')).body, 'with override');
  assert.deepEqual((await call('/api/agents/atlas/models?session_id=sess-1')).body.override, { model: 'c/d', provider: 'openrouter' });
  assert.equal((await send(call, 'one')).status, 202); const c1 = await until(() => fake.calls.find((c) => c.call === 'create'));
  assert.equal(c1.body.model, 'c/d'); assert.equal(c1.body.provider, 'openrouter'); assert.equal(c1.body.session_id, 'sess-1');
  fake.finish(fake.last(), 'run.completed', { output: 'x' }); await until(async () => !(await call('/api/agents/atlas/runs')).body.runs?.some((r) => r.state === 'running'));
  const other = await send(call, 'elsewhere', 'sess-2'); assert.equal(other.status, 202); const c2 = await until(() => fake.calls.filter((c) => c.call === 'create')[1]);
  assert.ok(!('model' in c2.body) && !('provider' in c2.body), 'the override is per chat');
  fake.finish(fake.last(), 'run.completed', { output: 'y' });
  const clear = await call('/api/agents/atlas/sessions/sess-1/model', { model: null }); assert.deepEqual(clear.body, { session_id: 'sess-1', model: null, provider: null }); check('ModelOverride', clear.body);
  assert.equal((await call('/api/agents/atlas/models?session_id=sess-1')).body.override, undefined);
  await until(async () => !(await call('/api/agents/atlas/runs')).body.runs?.some((r) => r.state === 'running'));
  assert.equal((await send(call, 'two')).status, 202); const c3 = await until(() => fake.calls.filter((c) => c.call === 'create')[2]); assert.ok(!('model' in c3.body));
  fake.finish(fake.last(), 'run.completed', { output: 'z' });
});

test('models: chat-completions agents get the override in the request body; agents without a list answer 409 models_unsupported', async (t) => {
  const { mock } = await hermes(t, { messages: [] }), legacy = await hermes(t, { legacy: true, messages: [] }); const { call } = await hub(t);
  await call('/api/connections', { ...mock.connection, name: 'atlas' }); await call('/api/connections', { ...legacy.mock.connection, name: 'old' });
  assert.equal((await call('/api/agents/atlas')).body.agent.capabilities.models, 'request'); assert.equal((await call('/api/agents/old')).body.agent.capabilities.models, 'none');
  const tooOld = await call('/api/agents/atlas/models'); assert.equal(tooOld.status, 409); assert.equal(tooOld.body.code, 'models_unsupported', 'API server without /api/model/options');
  for (const p of ['/api/agents/old/models']) { const x = await call(p); assert.equal(x.status, 409); assert.equal(x.body.code, 'models_unsupported'); }
  const x = await call('/api/agents/old/sessions/sess-1/model', { model: 'a/b' }); assert.equal(x.status, 409); assert.equal(x.body.code, 'models_unsupported');
  assert.equal((await call('/api/agents/atlas/sessions/sess-1/model', { model: 'gpt-x', provider: 'openai' })).status, 200);
  const before = mock.requests.length; assert.equal((await send(call, 'hi')).status, 202);
  const req = await until(() => mock.requests.slice(before).find((r) => r.path === '/v1/chat/completions' && r.body));
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; assert.equal(body.model, 'gpt-x'); assert.equal(body.provider, 'openai');
});

test('native gateway agent: capabilities.models native, /models lists, tool and status detail on the run stream and live v2', async (t) => {
  const x = await setup(t);
  const api = async (route, data) => { const r = await fetch(x.base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const agents = await waitFor(async () => { const a = (await api('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  assert.equal(agents[0].capabilities.models, 'native');
  const list = await api('/api/agents/default/models'); assert.equal(list.status, 200); assert.deepEqual(list.body, { mode: 'native', providers: [{ slug: 'custom', name: 'Custom', current: true, models: ['fake-model'] }] }); check('ModelList', list.body); check('Capabilities', agents[0].capabilities);
  const ov = await api('/api/agents/default/sessions/s1/model', { model: 'x' }); assert.equal(ov.status, 409); assert.equal(ov.body.code, 'models_unsupported');
  const s = sse(t, `${x.base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  const r = await api('/api/agents/default/messages', { messages: [{ role: 'user', content: 'steps please' }] }); assert.equal(r.status, 202, JSON.stringify(r.body));
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant', 15_000);
  assert.equal(reply.data.message.reasoning, 'thought about it');
  assert.deepEqual(reply.data.message.tools, [{ name: 'terminal', args: '{"command":"ls -la"}', result: '{"output":"a b","exit_code":0}', ok: true }]);
  for (const f of s.frames.filter((y) => y.event === 'run.step')) check('RunStepEvent', f.data); check('LiveEvent', reply.data);
  const kinds = s.frames.filter((f) => f.event === 'run.step').map((f) => f.data.kind); assert.deepEqual(kinds, ['commentary', 'status', 'tool.start', 'tool.end']);
  const end = s.frames.find((f) => f.event === 'run.step' && f.data.kind === 'tool.end').data; assert.equal(end.tool_id, 'call_s1'); assert.equal(end.duration_ms, 500); assert.equal(end.ok, true);
  assert.ok(s.frames.some((f) => f.event === 'typing' && f.data.state === 'tool' && f.data.tool_id === 'call_s1' && f.data.label === '{"command":"ls -la"}'));
  const text = await (await fetch(`${x.base}/api/agents/default/runs/${r.body.run_id}/events`)).text();
  assert.match(text, /event: foxfleet\.step\ndata: \{"kind":"status","turn_id":"[^"]+","text":"Context is getting long","level":"warn"\}/);
  assert.match(text, /event: foxfleet\.tool\ndata: \{"type":"tool\.start","turn_id":"[^"]+","tool_id":"call_s1","name":"terminal","preview":"\{\\"command\\":\\"ls -la\\"\}"\}/);
  await sleep(10);
});
