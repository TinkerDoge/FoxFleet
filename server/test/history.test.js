// Session history: Hermes session list/messages through the hub, and the transcript normaliser fed with realistic Hermes message rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
import { normalizeTranscript, sessionRow, flattenContent } from '../transcript.js';

async function setup(t, machines = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-hist-')), configPath = path.join(dir, 'config.json'); if (machines.length) await writeFile(configPath, JSON.stringify({ machines }));
  const server = await createHub({ configPath, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, data, method = data === undefined ? 'GET' : 'POST') => fetch(base + p, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { dir, base, call };
}

const ROWS = [
  { id: 1, role: 'system', content: 'You are Hermes…', timestamp: 1790000000 },
  { id: 2, role: 'user', content: [{ type: 'text', text: 'What is in this picture?\n\n📎 /tmp/report.pdf' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], timestamp: 1790000001.5 },
  { id: 3, role: 'assistant', content: null, reasoning_content: 'I should look at the image first.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'vision_analyze', arguments: '{"image":"/tmp/x.png","question":"describe"}' } }], timestamp: 1790000002 },
  { id: 4, role: 'tool', tool_call_id: 'call_1', tool_name: 'vision_analyze', content: '{"success": true, "analysis": "A red fox in the snow"}', timestamp: 1790000003 },
  { id: 5, role: 'assistant', content: '<think>Fox. Answer briefly.</think>It shows **a red fox**:\n\n| trait | value |\n|---|---|\n| color | red |\n\n```py\nprint("fox")\n```', finish_reason: 'stop', timestamp: 1790000004 },
  { id: 6, role: 'user', content: '<system-reminder>internal</system-reminder>thanks', timestamp: 1790000005 },
  { id: 7, role: 'assistant', content: 'x', display_kind: 'hidden' },
  { id: 8, role: 'assistant', content: '', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls -la /tmp"}' } }] },
  { id: 9, role: 'tool', tool_call_id: 'call_2', tool_name: 'terminal', content: '{"error":"permission denied"}' },
  { id: 10, role: 'assistant', content: 'That failed, sorry.' },
];
test('transcript: tool calls fold into the assistant turn, steps merge, tags and hidden rows disappear', () => {
  const out = normalizeTranscript(ROWS);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(out[0].content, 'What is in this picture?\n\n📎 /tmp/report.pdf'); assert.deepEqual(out[0].images, ['data:image/png;base64,AAAA']); assert.equal(out[0].ts, 1790000001500);
  const a = out[1]; assert.equal(a.tools.length, 1); assert.equal(a.tools[0].name, 'vision_analyze'); assert.match(a.tools[0].args, /image: \/tmp\/x\.png/); assert.match(a.tools[0].result, /red fox/); assert.equal(a.tools[0].ok, true);
  assert.match(a.reasoning, /look at the image first/); assert.match(a.reasoning, /Fox\. Answer briefly/); assert.ok(a.content.startsWith('It shows **a red fox**')); assert.ok(!a.content.includes('<think>'));
  assert.equal(out[2].content, 'thanks'); assert.ok(!JSON.stringify(out).includes('internal') && !JSON.stringify(out).includes('You are Hermes'));
  const last = out[3]; assert.equal(last.content, 'That failed, sorry.'); assert.equal(last.tools[0].ok, false); assert.equal(last.tools[0].name, 'terminal');
  assert.ok(!JSON.stringify(out).includes('"success"'), 'raw tool JSON is never shown as a message');
});
test('transcript: odd shapes do not throw (orphan tool rows, junk content, huge images)', () => {
  assert.deepEqual(normalizeTranscript([{ role: 'tool', tool_name: 'x', content: 'ok' }]).map((m) => m.tools?.[0].name), ['x']);
  assert.deepEqual(normalizeTranscript([null, 5, { role: 'wat' }, { role: 'user', content: 42 }]), []);
  assert.equal(flattenContent([{ type: 'image_url', image_url: { url: 'http://insecure/x.png' } }]).text, '[image]');
  assert.deepEqual(sessionRow({ id: 's1', title: ' Plan ', last_active: 1790000000, message_count: 4, preview: 'hello\nthere' }), { id: 's1', title: 'Plan', updated: 1790000000000, started: null, messages: 4, preview: 'hello there' });
});
test('transcript: Hermes notices are not user messages; a skill turn shows as typed', () => {
  const skill = '[IMPORTANT: The user has invoked the "review" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\nLong skill body\n\nThe user has provided the following instruction alongside the skill invocation: check PR 4\n\n[Runtime note: x]';
  const bundle = '[IMPORTANT: The user has invoked the "/clean /work" skill bundle, follow them.]\nUser instruction: tidy up\n\n[Loaded as part of the bundle: body]';
  const out = normalizeTranscript([
    { role: 'user', content: 'start the build' }, { role: 'assistant', content: 'started' },
    { role: 'user', content: '[IMPORTANT: Background process proc_9 completed (exit 0).\nOutput: ...]' },
    { role: 'user', content: 'wake up', display_kind: 'internal_notification' }, { role: 'user', content: 'done', display_kind: 'async_delegation_complete' },
    { role: 'user', content: [{ type: 'text', text: '[System: context compacted]' }] },
    { role: 'assistant', content: 'build passed' },
    { role: 'user', content: skill }, { role: 'assistant', content: 'ok' }, { role: 'user', content: bundle },
  ]);
  assert.deepEqual(out.map((m) => [m.role, m.content]), [['user', 'start the build'], ['assistant', 'started\n\nbuild passed'], ['user', '/review check PR 4'], ['assistant', 'ok'], ['user', '/clean /work tidy up']]);
});

test('Hermes sessions through the hub: list rows, paged messages are normalised', async (t) => {
  const mock = await mockHermes(t, { messages: ROWS }), { call } = await setup(t, [mock.connection]);
  const list = await (await call('/api/agents/fixture/sessions?limit=20')).json(); assert.equal(list.sessions[0].id, 'sess-1'); assert.equal(list.sessions[0].title, 'real session');
  const m = await (await call('/api/agents/fixture/sessions/sess-1/messages?limit=100')).json(); assert.equal(m.messages.length, 4); assert.equal(m.has_more, false);
  const q = mock.requests.filter((r) => /messages$/.test(r.path)).at(-1).query; assert.equal(q.get('limit'), '100'); assert.equal(q.get('order'), 'latest');
});

test('slash-command catalog: the full bundled Hermes list for a Hermes agent', async (t) => {
  const mock = await mockHermes(t), { call } = await setup(t, [mock.connection]);
  const r = await (await call('/api/agents/fixture/commands')).json(); assert.equal(r.source, 'bundled'); assert.ok(r.commands.length > 90);
  const by = Object.fromEntries(r.commands.map((c) => [c.name, c]));
  assert.equal(by.new.availability, 'app'); assert.equal(by.clear.availability, 'unavailable'); assert.match(by.clear.reason, /erminal/); assert.equal(by.model.availability, 'chat'); assert.match(by.compress.args, /here/); assert.ok(by.compress.aliases.includes('compact'));
  assert.ok(r.commands.every((c) => c.name && c.description && c.category && ['app', 'chat', 'unavailable'].includes(c.availability)));
});
