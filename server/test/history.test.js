// Session history: hub-side storage for API-key agents (with retention), Hermes session list/messages through the hub,
// and the transcript normaliser fed with realistic Hermes message rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
import { historyStore } from '../history.js';
import { normalizeTranscript, sessionRow, flattenContent } from '../transcript.js';

async function setup(t, machines = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-hist-')), configPath = path.join(dir, 'config.json'); if (machines.length) await writeFile(configPath, JSON.stringify({ machines }));
  const server = await createHub({ configPath, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, data, method = data === undefined ? 'GET' : 'POST') => fetch(base + p, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { dir, base, call };
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

test('API-key agents keep hub-side history: sessions list, load, rename, delete, retention', async (t) => {
  const api = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"Sure, **done**."}}]}\n\ndata: [DONE]\n\n'); }); });
  const apiBase = await listen(api); t.after(() => { api.closeAllConnections(); api.close(); });
  const { call } = await setup(t);
  assert.equal((await call('/api/connections', { name: 'glm', kind: 'openai', baseUrl: apiBase + '/v1', model: 'm', apiKey: 'k' })).status, 201);
  const ask = async (text, session) => { const r = await call('/api/agents/glm/chat', { messages: [{ role: 'user', content: text }], ...(session ? { session_id: session } : {}) }); const sid = r.headers.get('x-hermes-session-id'); await r.text(); await new Promise((x) => setTimeout(x, 40)); return sid; };
  const sid = await ask('Plan my week please', undefined); assert.match(sid, /^h_/);
  assert.equal(await ask('And the weekend?', sid), sid, 'the same session continues');
  await ask('Something else entirely');
  const list = await (await call('/api/agents/glm/sessions')).json(); assert.equal(list.total, 2); assert.equal(list.sessions[0].messages, 2); assert.equal(list.sessions.find((s) => s.id === sid).messages, 4);
  assert.equal(list.sessions.find((s) => s.id === sid).title, 'Plan my week please'); assert.match(list.sessions[0].preview, /done/);
  assert.equal((await (await call('/api/agents/glm/sessions?q=weekend')).json()).total, 1);
  const msgs = await (await call(`/api/agents/glm/sessions/${sid}/messages?limit=2`)).json(); assert.equal(msgs.messages.length, 2); assert.equal(msgs.has_more, true); assert.equal(msgs.messages[0].content, 'And the weekend?', 'the first page is the newest');
  const older = await (await call(`/api/agents/glm/sessions/${sid}/messages?limit=2&offset=2`)).json(); assert.equal(older.has_more, false); assert.equal(older.messages[0].content, 'Plan my week please');
  assert.equal((await call(`/api/agents/glm/sessions/${sid}`, { title: 'Weekly plan' }, 'PATCH')).status, 200);
  assert.equal((await (await call('/api/agents/glm/sessions?q=weekly')).json()).sessions[0].title, 'Weekly plan');
  assert.equal((await call(`/api/agents/glm/sessions/${sid}`, undefined, 'DELETE')).status, 200); assert.equal((await call(`/api/agents/glm/sessions/${sid}/messages`)).status, 404);
  assert.equal((await call('/api/history/settings', { retentionDays: 0 }, 'PUT')).status, 200); assert.equal((await (await call('/api/agents/glm/sessions')).json()).total, 0, 'retention 0 deletes everything');
  await ask('not kept'); assert.equal((await (await call('/api/agents/glm/sessions')).json()).total, 0);
  assert.equal((await call('/api/history/settings', { retentionDays: -3 }, 'PUT')).status, 400); assert.equal((await call('/api/history/settings', { retentionDays: 30 }, 'PUT')).status, 200);
});

test('retention drops old sessions and survives a restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-hist2-')); let t = Date.now();
  try {
    const h = await historyStore(path.join(dir, 'h.json'), { now: () => t }); await h.setRetention(7);
    await h.append('a', 'old', 'first', 'reply'); t += 3 * 86400000; await h.append('a', 'new', 'second', 'reply'); await new Promise((r) => setTimeout(r, 30));
    const again = await historyStore(path.join(dir, 'h.json'), { now: () => t }); assert.equal(again.list('a').total, 2); assert.equal(again.retentionDays, 7);
    t += 6 * 86400000; assert.deepEqual(again.list('a').sessions.map((s) => s.id), ['new'], 'the 9-day-old session is gone, the 6-day-old one stays');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Realistic rows as hermes_state / GET /api/sessions/{id}/messages return them (content may be null or an array, tool rows follow the call).
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

test('Hermes sessions through the hub: list rows, paged messages are normalised', async (t) => {
  const mock = await mockHermes(t, { messages: ROWS }), { call } = await setup(t, [mock.connection]);
  const list = await (await call('/api/agents/fixture/sessions?limit=20')).json(); assert.equal(list.sessions[0].id, 'sess-1'); assert.equal(list.sessions[0].title, 'real session');
  const m = await (await call('/api/agents/fixture/sessions/sess-1/messages?limit=100')).json(); assert.equal(m.messages.length, 4); assert.equal(m.has_more, false);
  const q = mock.requests.filter((r) => /messages$/.test(r.path)).at(-1).query; assert.equal(q.get('limit'), '100'); assert.equal(q.get('order'), 'latest');
});

test('slash-command catalog: full Hermes list for Hermes agents, only the local few for other kinds', async (t) => {
  const mock = await mockHermes(t), { call } = await setup(t, [mock.connection]);
  const r = await (await call('/api/agents/fixture/commands')).json(); assert.equal(r.source, 'bundled'); assert.ok(r.commands.length > 90);
  const by = Object.fromEntries(r.commands.map((c) => [c.name, c]));
  assert.equal(by.new.availability, 'app'); assert.equal(by.clear.availability, 'unavailable'); assert.match(by.clear.reason, /erminal/); assert.equal(by.model.availability, 'chat'); assert.match(by.compress.args, /here/); assert.ok(by.compress.aliases.includes('compact'));
  assert.ok(r.commands.every((c) => c.name && c.description && c.category && ['app', 'chat', 'unavailable'].includes(c.availability)));
  assert.equal((await call('/api/connections', { name: 'glm', kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k' })).status, 201);
  const g = await (await call('/api/agents/glm/commands')).json(); assert.equal(g.source, 'local'); assert.ok(g.commands.length < 10 && !g.commands.some((c) => ['clear', 'compress', 'model'].includes(c.name)), 'generic agents never show Hermes commands');
});
