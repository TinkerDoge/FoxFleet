import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../index.js';

const password = 'disposable-published-port-owner';
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-origin-'));
  const server = await createHub({ configPath: path.join(dir, 'config.json'), host: '0.0.0.0', ownerPassword: password, ...options });
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(dir, { recursive: true, force: true }); });
  // A distinct local address and ephemeral listener model the container side;
  // the wire Host below represents the published port. Never bind to the LAN.
  await new Promise((done) => server.listen(0, '127.0.0.2', done));
  const directAuthority = `127.0.0.2:${server.address().port}`;
  const request = (route, { authority = directAuthority, origin, method = 'GET', data, headers = {} } = {}) => new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = http.request({ hostname: '127.0.0.2', port: server.address().port, path: route, method, headers: { Host: authority, ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }); req.on('error', reject); req.end(body);
  });
  return { request, directAuthority };
}

test('unconfigured published authorities stay rejected while direct requests still work', async (t) => {
  const { request, directAuthority } = await setup(t, { trustedOrigins: [] });
  assert.equal((await request('/health', { authority: 'localhost:3080' })).status, 403);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/auth/login', { method: 'POST', origin: 'http://' + directAuthority, data: { username: 'owner', password } })).status, 200);
  assert.equal((await request('/api/auth/logout', { method: 'POST', origin: 'https://' + directAuthority, data: {} })).status, 403);
});

test('an explicit published origin admits its exact authority and retains owner authentication', async (t) => {
  const { request } = await setup(t, { trustedOrigins: ['http://localhost:3080', 'http://127.0.0.1:3080'] });
  const common = { authority: 'localhost:3080', origin: 'http://localhost:3080' };
  assert.equal((await request('/health', common)).status, 200);
  assert.equal((await request('/api/connections', common)).status, 401);
  const login = await request('/api/auth/login', { ...common, method: 'POST', data: { username: 'owner', password } }); assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const saved = await request('/api/connections', { ...common, method: 'POST', data: { name: 'local', host: 'localhost' }, headers: { Cookie: cookie } });
  assert.equal(saved.status, 201);
  assert.equal((await request('/api/connections', { ...common, headers: { Cookie: cookie } })).data.connections[0].name, 'local');
  assert.equal((await request('/health', { authority: '127.0.0.1:3080' })).status, 200);
});

test('trusted origins never admit an unlisted authority, port, scheme or a different listed Origin', async (t) => {
  const { request } = await setup(t, { trustedOrigins: ['http://localhost:3080', 'http://127.0.0.1:3080'] });
  for (const authority of ['attacker.test:3080', 'localhost:3081', 'localhost', 'localhost:3080?query', 'localhost:3080#fragment', 'user@localhost:3080']) {
    assert.equal((await request('/health', { authority, origin: 'http://localhost:3080' })).status, 403, authority);
  }
  for (const origin of ['http://attacker.test:3080', 'http://localhost:3081', 'https://localhost:3080', 'http://127.0.0.1:3080', 'null']) {
    assert.equal((await request('/api/auth/login', { authority: 'localhost:3080', origin, method: 'POST', data: { username: 'owner', password } })).status, 403, origin);
  }
  assert.equal((await request('/health', { authority: 'attacker.test:3080', headers: { 'X-Forwarded-Host': 'localhost:3080', 'X-Forwarded-Proto': 'http' } })).status, 403);
});

test('an explicitly configured HTTPS proxy origin accepts only its scheme and authority', async (t) => {
  const { request } = await setup(t, { trustedOrigins: ['https://hub.example.test:8443'] });
  assert.equal((await request('/health', { authority: 'hub.example.test:8443' })).status, 200);
  assert.equal((await request('/api/auth/login', { authority: 'hub.example.test:8443', origin: 'https://hub.example.test:8443', method: 'POST', data: { username: 'owner', password } })).status, 200);
  assert.equal((await request('/api/auth/login', { authority: 'hub.example.test:8443', origin: 'http://hub.example.test:8443', method: 'POST', data: { username: 'owner', password }, headers: { 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.equal((await request('/health', { authority: 'hub.example.test' })).status, 403);
});

test('trusted origins parse the comma-separated environment setting', async (t) => {
  const previous = process.env.FOXFLEET_TRUSTED_ORIGINS;
  t.after(() => { if (previous === undefined) delete process.env.FOXFLEET_TRUSTED_ORIGINS; else process.env.FOXFLEET_TRUSTED_ORIGINS = previous; });
  process.env.FOXFLEET_TRUSTED_ORIGINS = 'http://localhost:3080, https://hub.example.test:8443';
  const { request } = await setup(t);
  assert.equal((await request('/health', { authority: 'localhost:3080' })).status, 200);
  assert.equal((await request('/api/auth/login', { authority: 'hub.example.test:8443', origin: 'https://hub.example.test:8443', method: 'POST', data: { username: 'owner', password } })).status, 200);
});

test('trusted origins reject malformed, credentialed, wildcard and oversized lists', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-invalid-origin-')), configPath = path.join(dir, 'config.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const trustedOrigins of [
    null, {}, 42, [42], [''], ['ftp://hub.test'], ['https://*.hub.test'], ['https://user:pass@hub.test'], ['https://@hub.test'],
    ['https://hub.test/path'], ['https://hub.test/path/..'], ['https://hub.test?query'], ['https://hub.test?'], ['https://hub.test#fragment'], ['https://hub.test#'],
    ['https://hub.test\\other'], ['https://hub.test:0'], 'http://localhost:3080,,http://127.0.0.1:3080', Array.from({ length: 17 }, (_, index) => `https://hub${index}.test`),
  ]) await assert.rejects(() => createHub({ configPath, trustedOrigins }), /trusted origins/i, String(trustedOrigins));
  await assert.rejects(() => createHub({ configPath, host: '0.0.0.0', singleUser: true, trustedOrigins: ['http://localhost:3080'] }), /single-user/i);
});
