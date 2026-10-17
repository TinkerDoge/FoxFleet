// 0.4.1 redaction, second batch (FAKE secrets only): the saved connection's own secrets (its API server key and dashboard password, here
// the mock Hermes fixture values) in steps, tools and the stored log; argv arrays (["mysql","-pX"], ["deploy","--password","X"],
// ["sshpass","-p","X"]); sshpass's `-p X` with a space; and no false positives (`mysql -p db`, `cp -p`, ssh's own `-p 22`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redact, configStore } from '../config.js';
import { argsPreview, toolOutcome, stepText, guardCut, messageExtras } from '../steps.js';
import { fakeNative, NATIVE_FEATURES } from './native-hermes.js';
import { hub, hermes, sse, until } from './live2-helpers.js';

const PW = 'FAKEargv9999', KEY = 'api-secret', DASH = 'dashboard-secret'; // KEY / DASH: the mock Hermes connection's fake credentials
async function* files(dir) { for (const e of await readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) yield* files(p); else yield p; } }
const clean = (v, what, list) => { const s = typeof v === 'string' ? v : JSON.stringify(v); for (const x of list) assert.ok(!s.includes(x), `${what} leaks ${x}: ${s.slice(0, 300)}`); };

test('argv arrays and sshpass -p with a space are masked; mysql -p db, cp -p and ssh -p 22 are not', () => {
  assert.deepEqual(redact(['mysql', '-u', 'root', `-p${PW}`, 'db']), ['mysql', '-u', 'root', '-p[redacted]', 'db']);
  assert.deepEqual(redact(['/usr/bin/mysqldump', `-p${PW}`]), ['/usr/bin/mysqldump', '-p[redacted]']);
  assert.deepEqual(redact(['deploy', '--password', PW, '--token', PW, '--api-key', PW]), ['deploy', '--password', '[redacted]', '--token', '[redacted]', '--api-key', '[redacted]']);
  assert.deepEqual(redact(['sshpass', '-p', PW, 'ssh', 'host']), ['sshpass', '-p', '[redacted]', 'ssh', 'host']);
  assert.deepEqual(redact(['sshpass', '-e', `-p${PW}`, 'ssh']), ['sshpass', '-e', '-p[redacted]', 'ssh']);
  assert.equal(redact(`sshpass -p ${PW} ssh host`), 'sshpass -p [redacted] ssh host');
  assert.equal(redact(`sshpass -v -p '${PW}' ssh host`), 'sshpass -v -p [redacted] ssh host');
  for (const ok of [['mysql', '-p', 'db'], ['cp', '-p', 'a', 'b'], ['sshpass', '-f', 'pwfile', 'ssh', '-p', '22', 'host'], ['run', '--password', '--verbose'], ['find', '.', '-print']]) assert.deepEqual(redact(ok), ok, ok.join(' '));
  for (const ok of ['mysql -u root -p app', 'sshpass -f pwfile ssh -p 22 host', 'sshpass -e ssh -p22 host', 'sshpass -p -e ssh', 'cp -p a b']) assert.equal(redact(ok), ok, ok);
  // through the step helpers: a JSON argv, an object holding one, and a status text given as a list
  clean(argsPreview(JSON.stringify(['mysql', `-p${PW}`, 'db'])), 'argsPreview(argv)', [PW]); clean(argsPreview({ argv: ['sshpass', '-p', PW, 'ssh'] }), 'argsPreview({argv})', [PW]);
  clean(stepText(['mysql', `-p${PW}`]), 'stepText(argv)', [PW]); assert.equal(stepText(['mysql', `-p${PW}`]), 'mysql -p[redacted]');
  clean(messageExtras({ tools: [{ name: 'terminal', args: { cmd: ['deploy', '--password', PW] } }] }), 'messageExtras', [PW]);
});

test("a saved connection's own secrets are masked in steps, also when a cut leaves the start of one", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-conn-secret-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await configStore(path.join(dir, 'config.json'));
  const SECRET = 'FAKE-conn-key-0123456789abcdef';
  await store.add({ name: 'nova', host: '127.0.0.1', dashboardPort: 9119, apiServerPort: 8642, dashboardUser: 'admin', dashboardPass: 'FAKEdashpass77', apiServerKey: SECRET });
  clean(argsPreview({ command: `curl -H x:${SECRET} http://h` }), 'argsPreview', [SECRET, 'FAKE-conn']); clean(toolOutcome(`ok FAKEdashpass77`).result_preview, 'toolOutcome', ['FAKEdashpass77']);
  clean(stepText(`using ${SECRET}`), 'stepText', [SECRET]);
  assert.equal(guardCut('key FAKE-conn-ke…'), 'key [redacted]…', 'a literal secret cut short'); assert.equal(guardCut('key FAKE…'), 'key FAKE…', 'under 6 characters is just text');
  assert.equal(redact('the word short'), 'the word short');
  await store.remove('nova'); assert.equal(stepText(`using ${SECRET}`), `using ${SECRET}`, 'forgotten with the connection');
});

test('end to end (/v1/runs): the connection API key and dashboard password never reach the run stream, live v2 or the stored log', async (t) => {
  const fake = fakeNative(); const { mock } = await hermes(t, { features: NATIVE_FEATURES, messages: [], apiRoute: async (req, res, route, u) => (await fake.route(req, res, route, u)) !== false });
  assert.equal(mock.connection.apiServerKey, KEY); assert.equal(mock.connection.dashboardPass, DASH);
  const { call, base, dir } = await hub(t); await call('/api/connections', { ...mock.connection, name: 'atlas' });
  const s = sse(t, `${base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  const r = await call('/api/agents/atlas/messages', { messages: [{ role: 'user', content: 'go' }], session_id: 'sess-1' }); assert.equal(r.status, 202);
  const id = await until(() => fake.last());
  fake.emit(id, 'message.interim', { text: `Key is ${KEY}`, already_streamed: false });
  fake.emit(id, 'tool.started', { tool: 'terminal', preview: JSON.stringify(['curl', '-u', `admin:${DASH}`, '--token', KEY, 'http://agent']) });
  fake.emit(id, 'tool.completed', { tool: 'terminal', duration: 0.1, result: `auth ${KEY} ${DASH} ok` });
  fake.emit(id, 'reasoning.available', { text: `I will use ${KEY}` });
  fake.emit(id, 'message.delta', { delta: 'Done.' }); fake.finish(id, 'run.completed', { output: 'Done.' });
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant'); await s.wait((f) => f.event === 'run.finished');
  const secrets = [KEY, DASH];
  clean(reply.data.message.tools, 'message.new tools', secrets); clean(reply.data.message.reasoning, 'message.new reasoning', secrets); assert.match(JSON.stringify(reply.data.message.tools), /\[redacted\]/);
  clean(s.frames.filter((f) => f.event === 'run.step' || f.event === 'typing').map((f) => f.data), 'run.step / typing', secrets);
  const text = await (await fetch(`${base}/api/agents/atlas/runs/${r.body.run_id}/events`)).text();
  clean(text.split('\n\n').filter((f) => /^event: (foxfleet\.tool|foxfleet\.step|hermes\.tool\.progress)$/m.test(f)), 'run stream', secrets);
  const stored = await until(async () => { let out = ''; for await (const f of files(dir)) if (/live-events\.jsonl$/.test(f)) out += await readFile(f, 'utf8'); return out.includes(reply.data.message.hub_id) ? out : null; }, { tries: 100, ms: 30 });
  clean(stored, 'live-events.jsonl', secrets);
});
