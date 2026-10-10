// v0.4: raised limits, streamed file upload, transcribe, bridged agents (OpenAI-compatible,
// Scribe MCP inbox) and the Bot Screen relay. Disposable fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes, fakeDashboard, rawClient } from './fixtures.js';
import { createHub, LIMITS } from '../index.js';
import { wsAccept, wsConnect, encodeFrame, frameParser } from '../ws.js';

async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
async function setup(t, connections = [], options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-v04-')), configPath = path.join(dir, 'config.json');
  if (connections.length) await writeFile(configPath, JSON.stringify({ machines: connections }));
  const server = await createHub({ configPath, singleUser: !options.ownerPassword, ...options }); const base = await listen(server);
  t.after(async () => { await close(server); await new Promise((r) => setTimeout(r, 20)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const request = (route, data, method = 'GET', headers = {}) => fetch(base + route, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data) }) });
  return { server, base, request };
}

test('limits: chat accepts large multimodal bodies, other JSON stays at 4 MiB', async (t) => {
  assert.equal(LIMITS.chat, 10 * 1024 * 1024); assert.equal(LIMITS.file, 90 * 1024 * 1024);
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]);
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(6 * 1024 * 1024);
  const r = await request('/api/agents/fixture/chat', { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: image } }] }] }, 'POST');
  assert.equal(r.status, 200); await r.text();
  assert.equal((await request('/api/agents/fixture/chat', 'x'.repeat(LIMITS.chat + 10), 'POST')).status, 413);
  assert.equal((await request('/api/agents/fixture/skills/toggle', 'x'.repeat(5 * 1024 * 1024), 'POST')).status, 413);
});

test('files stream to the dashboard upload as multipart, with safe names and size checks', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]);
  const bytes = Buffer.from('%PDF-1.7 fixture \x00\x01\x02');
  const r = await request('/api/agents/fixture/files?name=' + encodeURIComponent('../../Báo cáo Q3.pdf') + '&type=application/pdf', bytes, 'POST', { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.status, 201); const out = await r.json();
  assert.match(out.path, /^\/home\/agent\/foxfleet-uploads\/\d{4}-\d{2}-\d{2}\/[a-z0-9]+-Báo cáo Q3\.pdf$/); assert.equal(out.size, bytes.length); assert.equal(out.mime, 'application/pdf');
  const up = mock.requests.find((x) => x.path === '/api/files/upload-stream');
  assert.match(up.contentType, /^multipart\/form-data; boundary=/); assert.ok(up.raw.includes(bytes)); assert.match(up.raw.toString('latin1'), /name="overwrite"\r\n\r\nfalse/);
  // Declared size above the cap is refused before streaming; other routes still demand JSON.
  const big = await new Promise((resolve) => { const req = http.request(new URL('/api/agents/fixture/files?name=a.bin', mock && r.url), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': LIMITS.file + 1 } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', () => resolve(0)); req.write('x'); });
  assert.equal(big, 413);
  assert.equal((await request('/api/agents/fixture/skills/toggle', 'x', 'POST', { 'Content-Type': 'application/octet-stream' })).status, 415);
  assert.equal((await request('/api/agents/fixture/files?name=a', bytes, 'POST', { 'Content-Type': 'application/octet-stream', Origin: 'https://attacker.example' })).status, 403);
});

test('transcribe forwards audio to the agent STT and validates the payload', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]);
  const r = await request('/api/agents/fixture/transcribe', { data_url: 'data:audio/mp4;base64,AAAA', mime_type: 'audio/mp4' }, 'POST');
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { transcript: 'xin chào hello', provider: 'local' });
  assert.equal(mock.requests.find((x) => x.path === '/api/audio/transcribe').body.mime_type, 'audio/mp4');
  assert.equal((await request('/api/agents/fixture/transcribe', { data_url: 'data:text/html;base64,AAAA' }, 'POST')).status, 400);
});

test('openai-compatible agents chat through the hub and never expose their key', async (t) => {
  const seen = [];
  const api = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c; seen.push({ path: req.url, auth: req.headers.authorization, body });
    if (req.headers.authorization !== 'Bearer glm-secret') { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/v4/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }] })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"hi from glm"}}]}\n\ndata: [DONE]\n\n');
  });
  const apiBase = await listen(api); t.after(() => close(api));
  const { request } = await setup(t);
  const add = await request('/api/connections', { name: 'GLM', kind: 'openai', baseUrl: apiBase + '/v4/', model: 'glm-5.3', apiKey: 'glm-secret', label: 'GLM 5.3' }, 'POST');
  assert.equal(add.status, 201); const text = await add.text(); assert.ok(!text.includes('glm-secret')); assert.equal(JSON.parse(text).connection.hasApiKey, true);
  const agent = (await (await request('/api/agents')).json()).agents[0];
  assert.equal(agent.kind, 'openai'); assert.equal(agent.chatReady, true); assert.equal(agent.displayName, 'GLM 5.3'); assert.equal(agent.capabilities.screen, false);
  const chat = await request('/api/agents/GLM/chat', { messages: [{ role: 'user', content: 'hello' }] }, 'POST');
  assert.equal(chat.status, 200); assert.match(await chat.text(), /hi from glm/);
  assert.equal(JSON.parse(seen.at(-1).body).model, 'glm-5.3'); assert.equal(JSON.parse(seen.at(-1).body).stream, true);
  await new Promise((r) => setTimeout(r, 50)); assert.equal((await request('/api/agents/GLM/sessions')).status, 200); // hub-side history (see history.test.js)
  assert.equal((await request('/api/connections/GLM', { kind: 'hermes' }, 'PUT')).status, 400);
  assert.equal((await request('/api/connections', { name: 'bad', kind: 'webhook' }, 'POST')).status, 400);
});

test('Scribe MCP inbox: owner message -> hub_get_messages -> hub_post_message -> session transcript', async (t) => {
  const { request, base } = await setup(t, [], { host: '0.0.0.0', ownerPassword: 'owner-pw', trustedOrigins: '' });
  // Loopback-created hub on 0.0.0.0 still only trusts its own authority; log in as the owner.
  const login = await request('/api/auth/login', { username: 'owner', password: 'owner-pw' }, 'POST'); const cookie = login.headers.get('set-cookie').split(';')[0];
  const owner = (route, data, method) => request(route, data, method, { Cookie: cookie });
  const add = await owner('/api/connections', { name: 'Scribe', kind: 'mcp-inbox', label: 'Scribe' }, 'POST');
  assert.equal(add.status, 201); const { inboxToken, connection } = await add.json();
  assert.match(inboxToken, /^[A-Za-z0-9_-]{43}$/); assert.equal(connection.hasInboxToken, true); assert.equal(connection.inboxTokenHash, undefined);
  const mcp = (body, token = inboxToken) => fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)).status, 401);
  assert.equal((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'x'.repeat(43))).status, 401);
  assert.equal((await fetch(base + '/mcp')).status, 405);
  const init = await (await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'foxfleet');
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = (await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools.map((x) => x.name);
  assert.deepEqual(tools, ['hub_get_messages', 'hub_post_message']);
  // Owner sends from the app: queued, synthetic stream returns the thread as the session id.
  const chat = await owner('/api/agents/Scribe/chat', { messages: [{ role: 'user', content: [{ type: 'text', text: 'Plan my Saturday' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] }, 'POST');
  assert.equal(chat.status, 200); const thread = chat.headers.get('x-hermes-session-id'); assert.match(await chat.text(), /Delivered to Scribe's inbox/);
  const got = (await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hub_get_messages', arguments: {} } })).json()).result.structuredContent;
  assert.equal(got.messages.length, 1); assert.equal(got.messages[0].thread_id, thread); assert.equal(got.messages[0].text, 'Plan my Saturday\n[image]');
  assert.equal((await (await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hub_get_messages', arguments: {} } })).json()).result.structuredContent.messages.length, 0);
  const post = (await (await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hub_post_message', arguments: { text: '**Saturday**: hike, then pho.', thread_id: thread } } })).json()).result;
  assert.equal(post.isError, false); assert.equal(post.structuredContent.thread_id, thread);
  const bad = (await (await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'hub_post_message', arguments: { text: 'x', thread_id: 'nope' } } })).json()).result; assert.equal(bad.isError, true);
  const sessions = (await (await owner('/api/agents/Scribe/sessions')).json()).sessions; assert.equal(sessions[0].id, thread);
  const messages = (await (await owner(`/api/agents/Scribe/sessions/${thread}/messages`)).json()).messages;
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']); assert.equal(messages[1].content, '**Saturday**: hike, then pho.'); assert.equal(messages[0].delivered, true);
  const agent = (await (await owner('/api/agents?bridged=1')).json()).agents[0]; assert.equal(agent.kind, 'mcp-inbox'); assert.equal(agent.online, true);
  // Rotating the token revokes the old one.
  const rotated = (await (await owner('/api/connections/Scribe/token', {}, 'POST')).json()).inboxToken;
  assert.equal((await mcp({ jsonrpc: '2.0', id: 7, method: 'ping' })).status, 401); assert.equal((await mcp({ jsonrpc: '2.0', id: 7, method: 'ping' }, rotated)).status, 200);
  assert.equal((await owner('/api/agents/Scribe/screen/observe', {}, 'POST')).status, 404);
});

test('screen relay: observe mints a single-use hub ticket and splices RFB; takeover/handback drive the lease', async (t) => {
  const log = [], mock = await mockHermes(t, { onUpgrade: fakeDashboard(log) });
  const { request, base } = await setup(t, [mock.connection]);
  const status = await (await request('/api/agents/fixture/screen/status')).json(); assert.equal(status.running, true); assert.equal(status.lease.holder, 'agent');
  assert.equal((await request('/api/agents/fixture/screen/takeover', {}, 'POST')).status, 409);
  const obs = await (await request('/api/agents/fixture/screen/observe', {}, 'POST')).json();
  assert.match(obs.ticket, /^[A-Za-z0-9_-]{32}$/); assert.ok(!JSON.stringify(obs).includes('display-ticket-1'));
  assert.equal(log.find((x) => x.path === '/api/ws').origin, `http://127.0.0.1:${mock.connection.dashboardPort}`);
  assert.equal(log.find((x) => x.rpc === 'display.observe').params.profile, 'default');
  // No Origin -> refused; wrong agent / reused ticket -> refused.
  assert.equal((await rawClient(base, `/api/agents/fixture/screen/ws?ticket=${obs.ticket}`, {})).status, 403);
  const obs2 = await (await request('/api/agents/fixture/screen/observe', {}, 'POST')).json();
  const ok = await rawClient(base, `/api/agents/fixture/screen/ws?ticket=${obs2.ticket}`, { Origin: base });
  assert.equal(ok.status, 101); assert.equal(ok.accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  ok.socket.write(encodeFrame(2, Buffer.from('key-down'), true));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ok.frames.map((f) => f.data.toString()), ['RFB 003.008\n', 'echo:key-down']);
  assert.equal((await rawClient(base, `/api/agents/fixture/screen/ws?ticket=${obs2.ticket}`, { Origin: base })).status, 403);
  const obs3 = await (await request('/api/agents/fixture/screen/observe', {}, 'POST')).json();
  assert.equal((await rawClient(base, `/api/agents/fixture/screen/ws?ticket=${obs3.ticket}`, { Origin: 'https://attacker.example' })).status, 403);
  const obs4 = await (await request('/api/agents/fixture/screen/observe', {}, 'POST')).json();
  const app = await rawClient(base, `/api/agents/fixture/screen/ws?ticket=${obs4.ticket}`, { Origin: 'https://appassets.androidplatform.net' }); assert.equal(app.status, 101); app.socket.destroy();
  const take = await (await request('/api/agents/fixture/screen/takeover', {}, 'POST')).json();
  assert.equal(take.lease.holder, 'human'); assert.ok(take.autoHandBackAt > Date.now());
  assert.equal(log.find((x) => x.rpc === 'display.lease.acquire').params.viewer_id, 'viewer-1');
  const back = await (await request('/api/agents/fixture/screen/handback', {}, 'POST')).json(); assert.equal(back.lease.holder, 'agent');
  ok.socket.destroy();
  assert.equal((await rawClient(base, `/api/agents/fixture/screen/ws?ticket=nope`, { Origin: base })).status, 403);
  assert.equal((await rawClient(base, `/api/agents/fixture/other/ws`, { Origin: base })).status, 404);
});

test('screen relay hands control back automatically after the takeover window', async (t) => {
  const { screenRelay } = await import('../screen.js');
  const calls = [];
  const fakeGateway = async () => { const handlers = {}; return { on: (e, f) => { handlers[e] = f; }, send: (text) => { const m = JSON.parse(text); calls.push(m.method); setImmediate(() => handlers.message(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: m.method === 'display.observe' ? { ticket: 'd', viewer_id: 'v', running: true } : { lease: { holder: m.method.endsWith('acquire') ? 'human' : 'agent', epoch: 1 } } }))); }, close() {} }; };
  const upstream = { dashboard: async () => new Response(JSON.stringify({ ticket: 'gw' }), { status: 200 }) };
  const relay = screenRelay(upstream, { takeoverMs: 50, connect: fakeGateway }); t.after(() => relay.clear());
  const m = { name: 'a', host: '127.0.0.1', dashboardPort: 1, profile: 'default' };
  await relay.observe(m); await relay.takeover(m);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(calls, ['display.observe', 'display.lease.acquire', 'display.lease.release']);
});
