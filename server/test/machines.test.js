// Easy onboarding: pairing codes, machines, one connector per machine with several Hermes profiles over one socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
import { machineStore, normalizeCode, validCode, CODE_TTL_MS } from '../machines.js';
import { fakeHermesHome, runConnector, tmpDir, readJson, waitFor } from './machine-helpers.js';
import { discoverProfiles, parseEnv, yamlScalars, hermesRoot, serviceSpec, chosen } from '../../connector/foxfleet-connector.mjs';

async function hub(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-machines-'));
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true, ...options }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 20)); await rm(dir, { recursive: true, force: true }); });
  const call = (route, data, method = data === undefined ? 'GET' : 'POST') => fetch(base + route, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { base, dir, call, json: async (...a) => (await call(...a)).json() };
}

test('pairing store: single use, 15-minute expiry, wrong-code lockout, bound to the user', async () => {
  let clock = 1_000_000; const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-ms-'));
  try {
    const ms = await machineStore(path.join(dir, 'machines.json'), { now: () => clock });
    const a = ms.createPairing('u1'); assert.match(a.code, /^[A-Z2-9]{10}$/); assert.equal(a.expires - clock, CODE_TTL_MS); assert.equal(a.display, `${a.code.slice(0, 5)}-${a.code.slice(5)}`);
    assert.equal(ms.pairingStatus('u1', a.display).state, 'waiting'); assert.throws(() => ms.pairingStatus('u2', a.code), /Unknown pairing code/);
    const r = await ms.redeem(a.display.toLowerCase(), { name: 'Desk', os: 'linux' }, '1.1.1.1'); assert.match(r.token, /^[0-9a-f]{32}\.[\w-]{20,}$/);
    assert.equal(ms.pairingStatus('u1', a.code).state, 'paired');
    await assert.rejects(ms.redeem(a.code, {}, '1.1.1.1'), /wrong, already used or expired/); // single use
    assert.equal(ms.authenticate(r.token).id, r.machineId); assert.equal(ms.authenticate(r.token.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))), null);
    const raw = await readFile(path.join(dir, 'machines.json'), 'utf8'); assert.ok(!raw.includes(r.token.split('.')[1]), 'only a hash is stored'); assert.equal((await stat(path.join(dir, 'machines.json'))).mode & 0o077, 0);
    const b = ms.createPairing('u1'); clock += CODE_TTL_MS + 1; assert.equal(ms.pairingStatus('u1', b.code).state, 'expired');
    await assert.rejects(ms.redeem(b.code, {}, '2.2.2.2'), /expired/);
    for (let i = 0; i < 8; i++) await assert.rejects(ms.redeem('AAAAAAAAAA', {}, '3.3.3.3'), /wrong/);
    const c = ms.createPairing('u1'); await assert.rejects(ms.redeem(c.code, {}, '3.3.3.3'), (e) => e.status === 429 && e.retryAfter > 0); // locked out even for a right code
    assert.ok((await ms.redeem(c.code, {}, '4.4.4.4')).machineId, 'another address is not locked');
    assert.equal(normalizeCode(' abcde-fghjk '), 'ABCDEFGHJK'); assert.equal(validCode('ABCDEFGHJ0'), false);
    for (let i = 0; i < 5; i++) ms.createPairing('u9'); assert.throws(() => ms.createPairing('u9'), /Too many open pairing codes/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('connector discovery follows the Hermes layout: default + profiles/<id> with a marker, no tombstones, valid ids only', async (t) => {
  const mock = await mockHermes(t), root = await fakeHermesHome(t, mock);
  assert.deepEqual(discoverProfiles(root).map((p) => p.profile), ['default', 'coder', 'research']);
  assert.equal(hermesRoot({ env: { HERMES_HOME: path.join(root, 'profiles', 'coder') } }), root, 'HERMES_HOME inside profiles/<id> resolves to the root');
  assert.equal(hermesRoot({ env: {}, platform: 'linux', home: '/home/x' }), '/home/x/.hermes'); assert.equal(hermesRoot({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32', home: 'C:\\U' }).startsWith('C:\\L'), true);
  assert.deepEqual(parseEnv('A=1\n# c\nexport B="two words"\nC=3 # note\n'), { A: '1', B: 'two words', C: '3' });
  assert.equal(yamlScalars('dashboard:\n  basic_auth:\n    username: admin\n    password: "pw"  # c\n')['dashboard.basic_auth.password'], 'pw');
  assert.deepEqual(chosen(discoverProfiles(root), { expose: 'selected', profiles: { coder: { expose: true }, nope: { expose: true } } }), ['coder']);
  const sd = serviceSpec('linux', { node: '/usr/bin/node', script: '/h/c.mjs', home: '/h' }); assert.match(sd.text, /ExecStart=\/usr\/bin\/node \/h\/c\.mjs run/); assert.match(sd.file, /systemd\/user\/foxfleet-connector\.service$/);
  assert.match(serviceSpec('darwin', { node: '/n', script: '/s', home: '/h' }).text, /dev\.foxfleet\.connector/); assert.match(serviceSpec('win32', { node: 'n.exe', script: 's.mjs' }).command, /run$/);
});

test('one connector, three profiles, one socket: pair, discover, register, route per agent, secrets stay local, revoke and rotate', async (t) => {
  const main = await mockHermes(t), other = await mockHermes(t), root = await fakeHermesHome(t, main);
  const h = await hub(t), cfgDir = await tmpDir();
  // research runs its own gateway/dashboard on other ports: per-profile overrides live in the connector's own config
  const status = await h.json('/api/machines'); assert.deepEqual(status.machines, []);
  const pairing = await (await h.call('/api/machines/pairing', {})).json();
  assert.match(pairing.url, new RegExp(`/c/${pairing.code}$`)); assert.match(pairing.link, /^foxfleet:\/\/pair\?hub=.+&code=/); assert.ok(pairing.commands.sh.startsWith('curl -fsSL ') && pairing.commands.sh.endsWith('| sh')); assert.match(pairing.commands.powershell, /^irm .*\.ps1 \| iex$/); assert.match(pairing.commands.node, /pair --hub .* --code /); assert.ok(Array.isArray(pairing.rows));
  assert.equal((await h.json(`/api/machines/pairing?code=${pairing.code}`)).state, 'waiting');
  // the installer script embeds the code and does not use it up
  const sh = await (await h.call(`/c/${pairing.code}`)).text(); assert.match(sh, /^#!\/bin\/sh/); assert.ok(sh.includes(`CODE='${pairing.code}'`)); assert.match(sh, /node -e 'process\.exit/); assert.equal((await h.json(`/api/machines/pairing?code=${pairing.code}`)).state, 'waiting');
  assert.match(await (await h.call(`/c/${pairing.code}.ps1`)).text(), /Invoke-WebRequest/); assert.equal((await h.call('/c/AAAAAAAAAI')).status, 404);
  // pair without running, then add the per-profile override, then run
  const pairRun = runConnector(t, ['pair', '--hub', h.base, '--code', pairing.display, '--name', 'Workstation', '--all', '--no-run', '--dashboard-port', String(main.connection.dashboardPort)], { hermes: root, configDir: cfgDir });
  assert.equal(await pairRun.done, 0, pairRun.out); assert.match(pairRun.out, /Paired as "Workstation"/); assert.match(pairRun.out, /\[shared\] research/);
  const cfgFile = path.join(cfgDir, 'connector.json'); assert.equal((await stat(cfgFile)).mode & 0o777, 0o600);
  const cfg = await readJson(cfgFile); assert.deepEqual(Object.keys(cfg.profiles), ['default', 'coder', 'research']); assert.ok(cfg.token.includes('.'));
  cfg.profiles.research = { expose: true, apiPort: other.connection.apiServerPort, dashboardPort: other.connection.dashboardPort }; await writeFile(cfgFile, JSON.stringify(cfg));
  assert.equal((await h.json(`/api/machines/pairing?code=${pairing.code}`)).state, 'paired');
  assert.equal((await h.call('/api/machines/redeem', { code: pairing.code })).status, 403, 'single use over HTTP');
  const run = runConnector(t, ['run'], { hermes: root, configDir: cfgDir });
  const agents = await waitFor(async () => { const a = (await h.json('/api/agents')).agents; return a.length === 3 && a.every((x) => x.chatReady) ? a : null; });
  assert.ok(agents, run.out + JSON.stringify((await h.json('/api/agents')).agents.map((a) => [a.name, a.status])));
  assert.deepEqual(agents.map((a) => a.name).sort(), ['coder', 'default', 'research']); assert.ok(agents.every((a) => a.kind === 'hermes' && a.capabilities.screen));
  assert.match(run.out, /Sharing 3 profile/); assert.doesNotMatch(JSON.stringify(agents), /127\.0\.0\.1|:\d{4,5}|machineId|api-secret|dashboard-secret/);
  // per-agent routing over the single socket, including different ports for research
  for (const n of ['default', 'coder', 'research']) { const s = await h.json(`/api/agents/${n}/sessions`); assert.equal(s.sessions[0].id, 'sess-1'); }
  const dashHits = (m, p) => m.requests.filter((r) => r.service === 'dashboard' && r.query?.get('profile') === p).length;
  assert.ok(dashHits(main, 'coder') > 0 && dashHits(main, 'default') > 0); assert.equal(dashHits(main, 'research'), 0, 'research never touched the main dashboard'); assert.ok(dashHits(other, 'research') > 0, 'research reached its own dashboard');
  const chat = await h.call('/api/agents/coder/chat', { messages: [{ role: 'user', content: 'hi' }] }); assert.equal(chat.status, 200); assert.ok((await chat.text()).length > 0);
  assert.ok(main.requests.some((r) => r.service === 'api' && r.path === '/p/coder/v1/chat/completions' && r.authorization === 'Bearer api-secret'), 'the connector injected the API key locally');
  assert.ok(main.logins > 0, 'the connector signed in to the dashboard itself');
  // the hub never saw the secrets
  for (const f of [h.dir + '/config.json', h.dir + '/machines.json']) { const raw = await readFile(f, 'utf8').catch(() => ''); assert.doesNotMatch(raw, /api-secret|dashboard-secret/); }
  assert.equal((await h.call('/api/connections/coder', { label: 'Coder' }, 'PUT')).status, 200, 'machine agents can be relabelled');
  assert.equal((await h.call('/api/connections/coder', undefined, 'DELETE')).status, 409, 'machine agents are removed via the machine');
  assert.equal((await h.call('/api/connections', { kind: 'hermes', name: 'x', connection: 'machine', machineId: '0'.repeat(32) })).status, 400);
  // machines list
  const [m] = (await h.json('/api/machines')).machines; assert.equal(m.name, 'Workstation'); assert.equal(m.online, true); assert.deepEqual(m.profiles.map((p) => p.profile), ['default', 'coder', 'research']); assert.doesNotMatch(JSON.stringify(m), /token|hash|127\.0\.0\.1/i);
  assert.equal((await (await h.call(`/api/machines/${m.id}`, { name: 'Desk PC' }, 'PATCH')).json()).machine.name, 'Desk PC');
  // a profile disappears on the machine: rescan removes its agent
  await writeFile(cfgFile, JSON.stringify({ ...(await readJson(cfgFile)), profiles: { default: { expose: true }, research: { expose: true, apiPort: other.connection.apiServerPort, dashboardPort: other.connection.dashboardPort } } }));
  const re = runConnector(t, ['profiles', '--profiles', 'default,research'], { hermes: root, configDir: cfgDir }); assert.equal(await re.done, 0, re.out);
  run.p.kill(); const run2 = runConnector(t, ['run'], { hermes: root, configDir: cfgDir });
  assert.deepEqual(await waitFor(async () => { const a = (await h.json('/api/agents')).agents.map((x) => x.name).sort(); return a.join() === 'default,research' ? a : null; }), ['default', 'research']);
  // rotate: old token dies at once, a new code re-pairs the SAME machine and keeps its agents
  const rot = await (await h.call(`/api/machines/${m.id}/token`, {})).json(); assert.ok(rot.code);
  assert.equal((await h.json('/api/machines')).machines[0].online, false, 'old token connection dropped');
  const re2 = runConnector(t, ['pair', '--hub', h.base, '--code', rot.code, '--no-run'], { hermes: root, configDir: cfgDir }); assert.equal(await re2.done, 0, re2.out);
  run2.p.kill(); const run3 = runConnector(t, ['run'], { hermes: root, configDir: cfgDir });
  assert.ok(await waitFor(async () => (await h.json('/api/machines')).machines[0].online), run3.out); const after = (await h.json('/api/machines')).machines; assert.equal(after.length, 1); assert.equal(after[0].id, m.id);
  // revoke: machine and its agents vanish, the connector is refused
  assert.equal((await h.call(`/api/machines/${m.id}`, undefined, 'DELETE')).status, 200);
  assert.deepEqual((await h.json('/api/agents')).agents, []); assert.deepEqual((await h.json('/api/machines')).machines, []);
  assert.equal((await h.call(`/api/machines/${m.id}`, undefined, 'DELETE')).status, 404);
});

test('redeem over HTTP: wrong codes lock the caller out; machines need a login in multi-user mode', async (t) => {
  const h = await hub(t);
  for (let i = 0; i < 8; i++) assert.equal((await h.call('/api/machines/redeem', { code: 'ZZZZZZZZZZ' })).status, 403);
  const locked = await h.call('/api/machines/redeem', { code: 'ZZZZZZZZZZ' }); assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) > 0);
  const multi = await hub(t, { singleUser: false });
  assert.equal((await multi.call('/api/machines')).status, 401); assert.equal((await multi.call('/api/machines/pairing', {})).status, 401);
});

test('connector refuses a plain-http non-local hub and a missing code', async (t) => {
  const dir = await tmpDir(), r = runConnector(t, ['pair', '--hub', 'http://hub.example.com', '--code', 'ABCDEFGHJK'], { configDir: dir, env: { FOXFLEET_ALLOW_INSECURE_HUB: '' } });
  assert.equal(await r.done, 1); assert.match(r.out, /Refusing plain http/);
  const r2 = runConnector(t, ['run'], { configDir: dir }); assert.equal(await r2.done, 1); assert.match(r2.out, /not paired yet/);
});
