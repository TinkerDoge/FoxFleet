// 0.4.1 redaction of step detail (Soran's 0.4.1 check): tool previews, results, step texts, typing labels, run.step and the reply's
// tools / reasoning go through config.js redact() BEFORE they are clipped, and a cut cannot leave the start of a secret. Only FAKE
// secrets are used here. Forms: sk- keys, ghp_ tokens, mysql-style -p<password>, --password=<x>, --password <x>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../config.js';
import { normalise } from '../hermes-runs.js';
import { argsPreview, toolOutcome, messageExtras, stepText, guardCut, safeClip } from '../steps.js';
import { fakeNative, NATIVE_FEATURES } from './native-hermes.js';
import { hub, hermes, sse, until } from './live2-helpers.js';
import { setup } from './ui-helpers.js';
import { waitFor } from './machine-helpers.js';

const SK = 'sk-test-FAKEFAKEFAKE0000000000', GH = 'ghp_FAKEFAKEFAKEFAKE0000000000', PW1 = 'FAKEpw1111', PW2 = 'FAKEpw2222', PW3 = 'FAKEpw3333';
const SECRETS = [SK, GH, PW1, PW2, PW3, 'FAKEFAKE', 'FAKEpw'];
const CMD = `mysql -u root -p${PW1} app; deploy --password=${PW2} --password ${PW3} --key ${SK} --gh ${GH}`;
const clean = (v, what) => { const s = typeof v === 'string' ? v : JSON.stringify(v); for (const x of SECRETS) assert.ok(!s.includes(x), `${what} leaks ${x}: ${s.slice(0, 300)}`); };
const dec = new TextDecoder();
async function* files(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) yield* files(p); else yield p; } }

test('redact(): every form is masked; ordinary flags are not', () => {
  assert.equal(redact(`mysql -u root -p${PW1} app`), 'mysql -u root -p[redacted] app');
  assert.equal(redact(`mysqldump -p'${PW1}' db`), 'mysqldump -p[redacted] db');
  assert.equal(redact(`sshpass -p${PW1} ssh host`), 'sshpass -p[redacted] ssh host');
  assert.equal(redact(`run --password=${PW2} x`), 'run --password=[redacted] x');
  assert.equal(redact(`run --password ${PW3} x`), 'run --password [redacted] x');
  assert.equal(redact(`run --pass "${PW3} more" x`), 'run --pass [redacted] x');
  assert.equal(redact(`key ${SK} and ${GH}`), 'key [redacted] and [redacted]');
  for (const ok of ['find . -name x -print', 'cp -p file dst', 'mkdir -p a/b', 'ssh -p 22 host', 'gcc -pthread -pedantic x.c', 'git log -p', 'tar -pxf a.tar',
    'mysql -u root -p app', 'mysql --port 3306 -h db', 'run --password --verbose', 'echo mysql; ls -p', 'the -p flag', 'python -prompt'])
    assert.equal(redact(ok), ok, `no false positive: ${ok}`);
});

test('previews: redacted before clipping, and a cut never leaves the start of a secret', () => {
  clean(argsPreview({ command: CMD }), 'argsPreview(object)'); clean(argsPreview(CMD), 'argsPreview(text)'); clean(argsPreview(JSON.stringify({ password: PW1, api_key: PW2 })), 'argsPreview(secret keys)');
  assert.match(argsPreview({ command: CMD }), /\[redacted\]/);
  clean(toolOutcome(`out ${SK} ${GH}`).result_preview, 'toolOutcome'); clean(toolOutcome({ token: PW1, out: `x --password=${PW2}` }).result_preview, 'toolOutcome(object)');
  assert.equal(toolOutcome({ error: `bad ${SK}` }).ok, false, 'ok is decided on the real result');
  clean(stepText(`commentary with ${SK}`), 'stepText');
  // a secret that straddles every clip boundary: the full form is redacted first, so nothing of it survives
  for (let pad = 150; pad <= 210; pad++) { const s = 'x'.repeat(pad) + ' ' + SK; clean(argsPreview(s), `argsPreview cut at ${pad}`); clean(stepText(s), `stepText cut at ${pad}`); clean(safeClip(s, 200), `safeClip cut at ${pad}`); }
  // text that arrives already cut (history args) is checked at the cut
  assert.equal(guardCut('use sk-test-FA…'), 'use [redacted]…'); assert.equal(guardCut('mysql -u r -pFA…'), 'mysql -u r -p[redacted]…'); assert.equal(guardCut('x --password=FA…'), 'x --password=[redacted]…');
  assert.equal(guardCut('cp -p fi…'), 'cp -p fi…'); assert.equal(guardCut('find . -pri…'), 'find . -pri…'); assert.equal(guardCut('no cut'), 'no cut');
  const x = messageExtras({ reasoning: `think ${SK} -- mysql -p${PW1}`, tools: [{ name: 'terminal', args: 'use sk-test-FA…', result: `ok ${GH}`, ok: true }] });
  clean(x, 'messageExtras'); assert.equal(x.tools[0].args, 'use [redacted]…');
  const long = messageExtras({ reasoning: 'é'.repeat(32_766) + ' ' + SK }); clean(long.reasoning, 'reasoning cut at 64 KiB'); assert.equal(long.reasoning_truncated, true);
});

test('/v1/runs adapter: foxfleet.tool, foxfleet.step and the commentary progress frame are redacted', () => {
  const link = {}, out = [['message.interim', { text: `Calling with ${SK}`, already_streamed: false }], ['subagent.start', { goal: `use ${GH}` }], ['tool.started', { tool: 'terminal', preview: CMD }], ['tool.completed', { tool: 'terminal', result: `done --password ${PW3} ${SK}` }]]
    .flatMap(([type, d]) => normalise({ ...d, type }, type, link).map((f) => dec.decode(f)));
  clean(out, 'run stream frames'); assert.equal(out.filter((f) => f.includes('[redacted]')).length, 5);
});

test('end to end on /v1/runs: run stream, live v2 run.step + typing label, message.new tools + reasoning and the stored log hold only redacted forms', async (t) => {
  const fake = fakeNative(); const { mock } = await hermes(t, { features: NATIVE_FEATURES, messages: [], apiRoute: async (req, res, route, u) => (await fake.route(req, res, route, u)) !== false });
  const { call, base, dir } = await hub(t); await call('/api/connections', { ...mock.connection, name: 'atlas' });
  const s = sse(t, `${base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  const r = await call('/api/agents/atlas/messages', { messages: [{ role: 'user', content: 'go' }], session_id: 'sess-1' }); assert.equal(r.status, 202);
  const id = await until(() => fake.last());
  fake.emit(id, 'message.interim', { text: `Using ${SK} now`, already_streamed: false });
  fake.emit(id, 'tool.started', { tool: 'terminal', preview: CMD });
  fake.emit(id, 'tool.completed', { tool: 'terminal', duration: 0.1, result: `token ${GH} -- mysql -p${PW1}` });
  fake.emit(id, 'subagent.start', { goal: `deploy --password=${PW2}` });
  fake.emit(id, 'reasoning.available', { text: `I need ${SK} and --password ${PW3}` });
  fake.emit(id, 'message.delta', { delta: 'Deployed.' }); fake.finish(id, 'run.completed', { output: 'Deployed.' });
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  clean(reply.data.message.tools, 'message.new tools'); clean(reply.data.message.reasoning, 'message.new reasoning'); assert.match(reply.data.message.reasoning, /\[redacted\]/); assert.match(reply.data.message.tools[0].args, /\[redacted\]/);
  await s.wait((f) => f.event === 'run.finished');
  const steps = s.frames.filter((f) => f.event === 'run.step'); assert.equal(steps.length, 4); clean(steps.map((f) => f.data), 'run.step');
  const labels = s.frames.filter((f) => f.event === 'typing' && f.data.label).map((f) => f.data.label); assert.ok(labels.some((l) => l.includes('[redacted]')), labels.join(' | ')); clean(labels, 'typing label');
  const text = await (await fetch(`${base}/api/agents/atlas/runs/${r.body.run_id}/events`)).text();
  const lifecycle = text.split('\n\n').filter((f) => /^event: (foxfleet\.tool|foxfleet\.step|hermes\.tool\.progress)$/m.test(f)); assert.ok(lifecycle.length >= 5); clean(lifecycle, 'run stream foxfleet.tool / foxfleet.step');
  const readLog = async () => { let out = ''; for await (const f of files(dir)) if (/live-events\.jsonl$/.test(f)) out += await readFile(f, 'utf8'); return out; };
  const stored = await until(async () => { const v = await readLog(); return v.includes(reply.data.message.hub_id) ? v : null; }, { tries: 100, ms: 30 }).catch(async () => { throw new Error(`reply not in the stored log; files: ${JSON.stringify(await (async () => { const a = []; for await (const f of files(dir)) a.push(path.relative(dir, f)); return a; })())}`); });
  assert.match(stored, /\[redacted\]/); clean(stored, 'live-events.jsonl');
});

test('chat completions: a Hermes tool label is redacted on typing, run.step and message.new tools', async (t) => {
  const frames = [`event: hermes.tool.progress\ndata: ${JSON.stringify({ tool: 'terminal', emoji: '💻', label: CMD })}\n\n`, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'];
  const { mock } = await hermes(t, { streamFrames: frames, streamDelayMs: 20, messages: [] }); const { call, base } = await hub(t);
  await call('/api/connections', { ...mock.connection, name: 'atlas' });
  const s = sse(t, `${base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  await call('/api/agents/atlas/messages', { messages: [{ role: 'user', content: 'x' }], session_id: 'sess-1' });
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  clean(reply.data.message.tools, 'message.new tools'); clean(s.frames.filter((f) => f.event === 'run.step' || f.event === 'typing').map((f) => f.data), 'run.step / typing');
  assert.match(s.frames.find((f) => f.event === 'run.step').data.preview, /\[redacted\]/);
});

test('native gateway: tool args/result, status, commentary and reasoning are redacted on the run stream, live v2 and message.new', async (t) => {
  const x = await setup(t);
  const api = async (route, data) => { const r = await fetch(x.base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await waitFor(async () => { const a = (await api('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  const s = sse(t, `${x.base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  const r = await api('/api/agents/default/messages', { messages: [{ role: 'user', content: 'secretsteps please' }] }); assert.equal(r.status, 202, JSON.stringify(r.body));
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant', 15_000);
  clean(reply.data.message.tools, 'native message.new tools'); clean(reply.data.message.reasoning, 'native message.new reasoning'); assert.match(reply.data.message.tools[0].args, /-p\[redacted\]/);
  clean(s.frames.filter((f) => f.event === 'run.step' || f.event === 'typing').map((f) => f.data), 'native run.step / typing');
  assert.equal(s.frames.filter((f) => f.event === 'run.step').length, 4);
  const text = await (await fetch(`${x.base}/api/agents/default/runs/${r.body.run_id}/events`)).text();
  clean(text.split('\n\n').filter((f) => /^event: (foxfleet\.tool|foxfleet\.step|hermes\.tool\.progress)$/m.test(f)), 'native run stream');
});
