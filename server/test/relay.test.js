import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
// Never import the unsafe legacy CLI (it reads the owner's config on import).
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const relay = /export\s+(?:async\s+)?function\s+createHub/.test(source) ? await import('../index.js') : {};
async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
async function setup(t, connections = [], options = {}) {
  assert.equal(typeof relay.createHub, 'function', 'createHub is exported without starting on import');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-test-')), configPath = path.join(dir, 'config.json');
  if (connections.length) await writeFile(configPath, JSON.stringify({ machines: connections }));
  let server; t.after(async () => { if (server) await close(server); await rm(dir, { recursive: true, force: true }); });
  server = await relay.createHub({ configPath, singleUser: !options.ownerPassword, ...options }); const base = await listen(server);
  const request = (route, data, method = 'GET', headers = {}) => fetch(base + route, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { server, base, request, configPath };
}
test('empty hub has health and no seeded fleet', async (t) => {
  const { request } = await setup(t); assert.deepEqual(await (await request('/health')).json(), { ok: true });
  assert.deepEqual(await (await request('/api/connections')).json(), { connections: [] }); assert.deepEqual(await (await request('/api/agents')).json(), { agents: [] }); { const a = await (await request('/api/auth')).json(); assert.equal(a.required, false); assert.equal(a.authenticated, true); }
});
test('connection CRUD persists, redacts secrets and keeps blanks on edit', async (t) => {
  const { request, configPath } = await setup(t);
  const r = await request('/api/connections', { name: 'desk', host: '192.168.1.10', dashboardPass: 'owner-password', apiServerKey: 'owner-key' }, 'POST'); assert.equal(r.status, 201); const text = await r.text(); assert.ok(!text.includes('owner-password')); assert.ok(!text.includes('owner-key'));
  assert.equal((await request('/api/connections/desk', { profile: 'writer', dashboardPass: '', apiServerKey: '' }, 'PUT')).status, 200);
  const stored = JSON.parse(await readFile(configPath, 'utf8')).machines[0]; assert.equal(stored.dashboardPass, 'owner-password'); assert.equal(stored.apiServerKey, 'owner-key'); assert.equal(stored.profile, 'writer');
  const item = (await (await request('/api/connections')).json()).connections[0]; assert.equal(item.hasDashboardPass, true); assert.equal(item.hasApiServerKey, true); assert.equal(item.dashboardPass, undefined);
  assert.equal((await request('/api/connections/desk', undefined, 'DELETE')).status, 200); assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).machines, []);
});
test('invalid, duplicate, malformed and oversized input is rejected', async (t) => {
  const { request, base } = await setup(t);
  for (const data of [{ name: '../x', host: 'localhost' }, { name: 'x', host: 'localhost/evil' }, { name: 'x', host: 'localhost', dashboardPort: 0 }, { name: 'x', host: 'localhost', apiServerPort: 65536 }, { name: 'x', host: 'localhost', profile: '../default' }, { name: 'x', host: 'localhost', dashboardUrl: 'https://user:password@example.com/' }]) assert.equal((await request('/api/connections', data, 'POST')).status, 400);
  assert.equal((await request('/api/connections', { name: 'desk', host: 'localhost' }, 'POST')).status, 201); assert.equal((await request('/api/connections', { name: 'desk', host: 'localhost' }, 'POST')).status, 409);
  assert.equal((await fetch(base + '/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400); assert.equal((await fetch(base + '/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(5 * 1024 * 1024) })).status, 413); assert.equal((await request('/api/agents/missing/chat', { messages: [] }, 'POST')).status, 404);
});
test('malformed saved config fails safely', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-invalid-')); t.after(() => rm(dir, { recursive: true, force: true })); const configPath = path.join(dir, 'config.json'); await writeFile(configPath, '{password secret');
  assert.equal(typeof relay.createHub, 'function'); await assert.rejects(() => relay.createHub({ configPath, singleUser: true }), (e) => !e.message.includes('secret') && /configuration/i.test(e.message));
});
test('LAN bind requires owner password and strict sessions logout', async (t) => {
  assert.equal(typeof relay.createHub, 'function'); await assert.rejects(() => relay.createHub({ host: '0.0.0.0', singleUser: true }), /single-user/i);
  const { request } = await setup(t, [], { host: '0.0.0.0', ownerPassword: 'test-owner-password' }); assert.equal((await request('/api/connections')).status, 401); { const a = await (await request('/api/auth')).json(); assert.equal(a.required, true); assert.equal(a.authenticated, false); }
  assert.equal((await request('/api/auth/login', { username: 'owner', password: 'wrong' }, 'POST')).status, 401); const login = await request('/api/auth/login', { username: 'owner', password: 'test-owner-password' }, 'POST'); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Max-Age=/); const headers = { Cookie: cookie.split(';')[0] };
  assert.equal((await request('/api/connections', undefined, 'GET', headers)).status, 200); assert.equal((await request('/api/auth/logout', {}, 'POST', headers)).status, 200); assert.equal((await request('/api/connections', undefined, 'GET', headers)).status, 401);
});
test('untrusted host and cross-origin mutations rejected on loopback', async (t) => {
  const { request, base } = await setup(t);
  // Undici intentionally replaces the Host header. Use the actual wire protocol.
  const status = await new Promise((resolve, reject) => { const req = http.get(base + '/api/connections', { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(status, 403); assert.equal((await request('/api/connections', { name: 'x', host: 'localhost' }, 'POST', { Origin: 'https://attacker.example' })).status, 403); assert.equal((await request('/api/auth/logout', {}, 'POST', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});
test('readiness independently probes dashboard, management and API', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]); const a = (await (await request('/api/agents')).json()).agents[0]; assert.equal(a.online, true); assert.equal(a.managementReady, true); assert.equal(a.chatReady, true); assert.equal(a.profile, undefined); assert.equal(a.activeSessions, 2); assert.equal(a.capabilities.screen, true); assert.equal(a.status, 'ready'); assert.equal((await (await request('/api/connections/fixture/test', {}, 'POST')).json()).checks.api.ok, true);
});
for (const [name, options, online] of [['non-ok dashboard', { badStatus: 503 }, false], ['malformed dashboard', { malformedStatus: true }, false], ['malformed API', { malformedCapabilities: true }, true], ['API unauthorized', { apiStatus: 401 }, true], ['chat unavailable', { noChat: true }, true]]) test(`${name} cannot produce false readiness`, async (t) => {
  const mock = await mockHermes(t, options), { request } = await setup(t, [mock.connection]); const a = (await (await request('/api/agents')).json()).agents[0]; assert.equal(a.online, online); if (options.malformedCapabilities || options.apiStatus || options.noChat) assert.equal(a.chatReady, false);
});
test('offline and timeout checks are bounded and sanitized', async (t) => {
  const mock = await mockHermes(t, { hangApi: true }), { request } = await setup(t, [mock.connection, { ...mock.connection, name: 'offline', dashboardPort: 1, apiServerPort: 1 }], { timeoutMs: 100 }); const start = Date.now(), text = await (await request('/api/agents')).text(); assert.ok(Date.now() - start < 3000); const a = JSON.parse(text).agents; assert.equal(a[0].chatReady, false); assert.equal(a[1].online, false); assert.ok(!text.includes('ECONN')); assert.ok(!text.includes('api-secret'));
});
test('legacy models fallback reports capabilities unsupported honestly', async (t) => {
  const mock = await mockHermes(t, { legacy: true }), { request } = await setup(t, [mock.connection]); const a = (await (await request('/api/agents')).json()).agents[0]; assert.equal(a.chatReady, true); assert.equal(a.capabilities.chat, true); assert.match(a.checks.api.message, /models|capabilities/i);
});
test('dashboard 401 retries once and saved profile scopes all management', async (t) => {
  const mock = await mockHermes(t, { expireOnce: true }), { request } = await setup(t, [{ ...mock.connection, profile: 'writer' }]); assert.equal((await request('/api/agents/fixture/sessions')).status, 200); assert.equal(mock.logins, 2);
  for (const route of ['sessions/search?q=test', 'cron', 'skills', 'logs?tail=20', 'config', 'profiles', 'usage']) assert.equal((await request('/api/agents/fixture/' + route)).status, 200);
  for (const r of mock.requests.filter((r) => r.service === 'dashboard' && r.path.startsWith('/api/') && r.path !== '/api/status')) assert.equal(r.query.get('profile'), 'writer'); assert.equal((await request('/api/agents/fixture/sessions?profile=other')).status, 400);
});
test('auth-disabled dashboard needs no login cookie', async (t) => {
  const mock = await mockHermes(t, { noAuth: true }), { request } = await setup(t, [mock.connection]); assert.equal((await request('/api/agents/fixture/sessions')).status, 200); assert.equal(mock.logins, 0);
});
test('browser skill POST translates to upstream PUT with exact body', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]); assert.equal((await request('/api/agents/fixture/skills/toggle', { name: 'web-search', enabled: false, ignored: 'discard' }, 'POST')).status, 200); assert.deepEqual(mock.requests.find((r) => r.path === '/api/skills/toggle' && r.method === 'PUT').body, { name: 'web-search', enabled: false }); assert.equal((await request('/api/agents/fixture/skills/toggle', { name: 'x', enabled: 'yes' }, 'POST')).status, 400);
});
test('chat scopes profile and preserves session identity and SSE bytes', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [{ ...mock.connection, profile: 'writer' }]); const r = await request('/api/agents/fixture/chat', { messages: [{ role: 'user', content: 'hello' }], session_id: 'existing-session' }, 'POST'); assert.equal(r.status, 200); assert.equal(r.headers.get('x-hermes-session-id'), 'sess-1'); assert.match(await r.text(), /hello[\s\S]*\[DONE\]/); const call = mock.requests.find((r) => r.path.endsWith('/v1/chat/completions')); assert.equal(call.path, '/p/writer/v1/chat/completions'); assert.equal(call.session, 'existing-session'); assert.equal(call.body.model, 'hermes-agent'); assert.equal((await request('/api/agents/fixture/sessions/sess-1/messages')).status, 200);
});
test('redirects never forward saved credentials', async (t) => {
  let stolen = false; const catcher = http.createServer((req, res) => { stolen = true; res.end('{}'); }), target = await listen(catcher); t.after(() => close(catcher)); const mock = await mockHermes(t, { redirectApi: target }), { request } = await setup(t, [mock.connection]); assert.equal((await (await request('/api/agents')).json()).agents[0].chatReady, false); assert.equal(stolen, false);
});
test('downstream stream close aborts upstream transport', async (t) => {
  let done; const stopped = new Promise((r) => { done = r; }); const mock = await mockHermes(t, { slowStream: true, onStreamClose: done }), { base } = await setup(t, [mock.connection]); const abort = new AbortController(), r = await fetch(base + '/api/agents/fixture/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }), signal: abort.signal }); const reader = r.body.getReader(); await reader.read(); abort.abort(); await reader.cancel().catch(() => {}); await Promise.race([stopped, new Promise((_, reject) => { setTimeout(() => reject(new Error('upstream did not abort')), 2000).unref(); })]);
});
test('config and logs redact credentials recursively and in text', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]); const text = await (await request('/api/agents/fixture/config')).text(); assert.ok(text.includes('visible')); for (const secret of ['different-secret', 'hidden-token', 'another-secret', '"hidden"']) assert.ok(!text.includes(secret), secret); const logs = await (await request('/api/agents/fixture/logs')).text(); for (const secret of ['dashboard-secret', 'api-secret', 'surprise-token', 'private-value']) assert.ok(!logs.includes(secret), secret);
});
test('artifacts require transcript provenance and refuse sensitive or traversal paths', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]); for (const file of ['/not-mentioned.png', '/outputs/.env', '/outputs/../secret.txt', '/outputs/notes.txt.back', 'C:\\Users\\owner\\.ssh\\id_rsa']) assert.equal((await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: [file] }, 'POST')).status, 400);
  const r = await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['/outputs/result.png'] }, 'POST'); assert.equal(r.status, 201); const a = (await r.json()).artifacts[0]; assert.equal(a.agent, 'fixture'); assert.equal(a.profile, 'default'); assert.equal(a.session_id, 'sess-1'); assert.equal(a.mime, 'image/png'); assert.equal((await (await request('/api/agents/fixture/artifacts?session_id=sess-1')).json()).artifacts[0].id, a.id); assert.deepEqual((await (await request('/api/agents/fixture/artifacts?session_id=other')).json()).artifacts, []);
});
test('artifact bytes and ranges use original saved session/profile', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [{ ...mock.connection, profile: 'writer' }]); const a = (await (await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['/outputs/result.png'] }, 'POST')).json()).artifacts[0]; const r = await request(`/api/agents/fixture/artifacts/${a.id}/content?download=1`); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), mock.bytes); assert.match(r.headers.get('content-disposition'), /attachment/); const p = await request(`/api/agents/fixture/artifacts/${a.id}/content`, undefined, 'GET', { Range: 'bytes=0-2' }); assert.equal(p.status, 206); assert.equal(p.headers.get('content-range'), 'bytes 0-2/6'); assert.deepEqual(Buffer.from(await p.arrayBuffer()), mock.bytes.subarray(0, 3)); for (const call of mock.requests.filter((r) => r.path === '/api/fs/download')) { assert.equal(call.query.get('profile'), 'writer'); assert.equal(call.query.get('session_id'), 'sess-1'); assert.equal(call.query.get('path'), '/outputs/result.png'); }
});
test('artifact HTML/SVG are sandboxed and text previews bounded', async (t) => {
  const mock = await mockHermes(t, { largeText: true }), { request } = await setup(t, [mock.connection]); const a = (await (await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['/outputs/report.html', '/outputs/icon.svg', '/outputs/notes.txt'] }, 'POST')).json()).artifacts; const html = await request(`/api/agents/fixture/artifacts/${a[0].id}/content`); assert.match(html.headers.get('content-type'), /text\/plain/); assert.match(html.headers.get('content-security-policy'), /sandbox/); assert.equal(html.headers.get('x-content-type-options'), 'nosniff'); await html.text(); const svg = await request(`/api/agents/fixture/artifacts/${a[1].id}/content`); assert.match(svg.headers.get('content-type'), /image\/svg\+xml/); assert.match(svg.headers.get('content-security-policy'), /sandbox/); await svg.text(); assert.equal((await request(`/api/agents/fixture/artifacts/${a[2].id}/content`)).status, 413);
});
test('artifact transcript fallback authenticates API and preserves safe upstream refusals', async (t) => {
  const mock = await mockHermes(t, { noDashboardMessages: true, denyFile: true }), { request } = await setup(t, [mock.connection]); const a = (await (await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['/outputs/result.png'] }, 'POST')).json()).artifacts[0]; const r = await request(`/api/agents/fixture/artifacts/${a.id}/content`); assert.equal(r.status, 403); assert.ok(!(await r.text()).includes('secret')); assert.equal((await request('/api/agents/fixture/artifacts/missing/content')).status, 404);
});
test('relative artifact paths with spaces retain session cwd provenance', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]);
  const r = await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: ['outputs/Launch plan.md'] }, 'POST'); assert.equal(r.status, 201);
  const a = (await r.json()).artifacts[0]; assert.equal(a.kind, 'doc');
  assert.equal((await request(`/api/agents/fixture/artifacts/${a.id}/content?download=1`)).status, 200);
  const call = mock.requests.find((v) => v.path === '/api/fs/download'); assert.equal(call.query.get('path'), 'outputs/Launch plan.md'); assert.equal(call.query.get('session_id'), 'sess-1');
  for (const file of ['outputs/../secret.md', 'outputs/.env.local', 'https://evil.test/a', '//evil.test/a']) assert.equal((await request('/api/agents/fixture/artifacts', { session_id: 'sess-1', paths: [file] }, 'POST')).status, 400);
});
test('usage forwards bounded days to official endpoint and preserves token metrics', async (t) => {
  const mock = await mockHermes(t), { request } = await setup(t, [mock.connection]); const data = await (await request('/api/agents/fixture/usage?days=7')).json();
  assert.equal(data.input_tokens, 12); assert.equal(data.total_tokens, 26); assert.equal(data.token, '[redacted]');
  assert.equal(mock.requests.find((v) => v.path === '/api/analytics/usage').query.get('days'), '7'); assert.equal((await request('/api/agents/fixture/usage?days=1000')).status, 400);
});
test('chunked oversized request returns bounded JSON error', async (t) => {
  const { base } = await setup(t);
  const status = await new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port: base.split(':').pop(), path: '/api/connections', method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.write('x'.repeat(5 * 1024 * 1024)); req.end(); });
  assert.equal(status, 413);
});
