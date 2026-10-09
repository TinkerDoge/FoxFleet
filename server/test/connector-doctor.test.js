// Native gateway discovery and `connector doctor`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gatewayCommand, nativeDoctor } from '../../connector/foxfleet-connector.mjs';
import { CONNECTOR } from './machine-helpers.js';
import { FAKE } from './ui-helpers.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'ff-gw-'));
async function checkout(dir) { await mkdir(path.join(dir, 'tui_gateway'), { recursive: true }); await writeFile(path.join(dir, 'tui_gateway', 'entry.py'), ''); await mkdir(path.join(dir, 'venv', 'bin'), { recursive: true }); await writeFile(path.join(dir, 'venv', 'bin', 'python'), ''); return path.join(dir, 'venv', 'bin', 'python'); }

test('discovery order: explicit config, env, configured dir, checkout next to the root, then the hermes launcher', async () => {
  const root = await tmp(), home = await tmp(), empty = { PATH: '' }, why = [];
  assert.equal(gatewayCommand(root, {}, empty, why), null); assert.match(why.join(' '), /no Hermes checkout or launcher/);
  assert.equal(gatewayCommand(root, { uiGateway: 'off', uiGatewayCommand: ['x'] }, empty), null, 'off wins');
  assert.deepEqual(gatewayCommand(root, { uiGatewayCommand: ['/p/python', '-m', 'tui_gateway.entry'], uiGatewayCwd: '/c' }, empty), { cmd: '/p/python', args: ['-m', 'tui_gateway.entry'], cwd: '/c', via: 'uiGatewayCommand in the connector config' });
  assert.equal(gatewayCommand(root, {}, { ...empty, FOXFLEET_HERMES_GATEWAY_CMD: '["/e/py","-m","tui_gateway.entry"]' }).cmd, '/e/py');
  const bad = []; assert.equal(gatewayCommand(root, {}, { ...empty, FOXFLEET_HERMES_GATEWAY_CMD: 'nope' }, bad), null); assert.match(bad.join(), /not valid JSON/);
  const agentDir = await tmp(), py = await checkout(agentDir); assert.equal(gatewayCommand(root, { hermesAgentDir: agentDir }, empty).cmd, py); assert.equal(gatewayCommand(root, {}, { ...empty, HERMES_AGENT_DIR: agentDir }).cwd, agentDir);
  const next = path.join(root, 'hermes-agent'), py2 = await checkout(next); assert.equal(gatewayCommand(root, {}, empty).cmd, py2);
  // launcher only: a `hermes` script whose first line names the interpreter it is installed in
  const bin = await tmp(), fakePy = path.join(bin, 'py'); await writeFile(fakePy, ''); await writeFile(path.join(bin, 'hermes'), `#!${fakePy}\nprint(1)\n`); await chmod(path.join(bin, 'hermes'), 0o755);
  const r2 = await tmp(), g = gatewayCommand(r2, {}, { PATH: bin }); assert.equal(g.cmd, fakePy); assert.match(g.via, /interpreter of/); assert.equal(g.cwd, undefined);
  await writeFile(path.join(bin, 'hermes'), '#!/usr/bin/env python3\n'); const w = []; assert.equal(gatewayCommand(r2, {}, { PATH: bin }, w), null); assert.match(w.join(), /interpreter could not be read/, 'env-style shebangs are not guessed');
});

test('doctor: says what is missing and how to fix it; reports a gateway that does not start', async () => {
  const root = await tmp(); await mkdir(path.join(root, 'profiles', 'a'), { recursive: true }); await writeFile(path.join(root, 'profiles', 'a', '.env'), 'x=1\n'); await writeFile(path.join(root, '.env'), 'x=1\n');
  const none = await nativeDoctor({}, { env: { PATH: '' }, root }); assert.equal(none.find((c) => c.id === 'gateway').status, 'warn'); assert.match(none.find((c) => c.id === 'gateway').fix, /uiGatewayCommand|HERMES_AGENT_DIR/);
  const ok = await nativeDoctor({ uiGatewayCommand: ['py'] }, { env: {}, root, probe: async () => ({ ok: true, ms: 12 }) }); assert.equal(ok.find((c) => c.id === 'gateway-start').status, 'ok');
  const bad = await nativeDoctor({ uiGatewayCommand: ['py'] }, { env: {}, root, probe: async () => ({ ok: false, error: "No module named 'ruamel'" }) }); const f = bad.find((c) => c.id === 'gateway-start'); assert.equal(f.status, 'fail'); assert.match(f.fix, /Python 3\.14/);
  const nop = await nativeDoctor({}, { env: { PATH: '' }, root: await tmp() }); assert.equal(nop.find((c) => c.id === 'profiles').status, 'fail');
});

test('`connector doctor` really starts the configured gateway and exits 0; a broken command exits 1', async () => {
  const root = await tmp(); await writeFile(path.join(root, '.env'), 'x=1\n'); const cfgDir = await tmp();
  const run = async (cmd) => { await writeFile(path.join(cfgDir, 'connector.json'), JSON.stringify({ hub: 'http://127.0.0.1:1', token: 'a.b', name: 'x', expose: 'all', profiles: {}, uiGatewayCommand: cmd })); return spawnSync(process.execPath, ['--experimental-websocket', CONNECTOR, 'doctor'], { env: { ...process.env, FOXFLEET_CONFIG_DIR: cfgDir, FOXFLEET_HERMES_HOME: root, PATH: '' }, encoding: 'utf8', timeout: 30_000 }); };
  const good = await run([process.execPath, FAKE]); assert.equal(good.status, 0, good.stdout + good.stderr); assert.match(good.stdout, /\[ok\]\s+gateway-start: the gateway starts and reports ready/);
  const bad = await run([process.execPath, '-e', 'process.exit(3)']); assert.equal(bad.status, 1); assert.match(bad.stdout, /\[FAIL\] gateway-start: the gateway did not start: exited with code 3/);
});
