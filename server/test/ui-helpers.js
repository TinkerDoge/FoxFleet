// Shared setup: real hub + real connector + a gateway (fake by default, real with HERMES_REAL_GATEWAY_TEST).
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';
import { fakeHermesHome, runConnector, tmpDir, readJson, waitFor } from './machine-helpers.js';

export const FAKE = path.join(import.meta.dirname, 'fake-gateway.mjs');
export const REAL = process.env.HERMES_REAL_GATEWAY_TEST ? JSON.parse(process.env.HERMES_REAL_GATEWAY_TEST) : null;

export async function setup(t, { gateway = true } = {}) {
  const main = await mockHermes(t), root = await fakeHermesHome(t, main, { profiles: [] });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-ui-')), cfgDir = await tmpDir();
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, call = (route, data) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const pairing = await (await call('/api/machines/pairing', {})).json();
  const pr = runConnector(t, ['pair', '--hub', base, '--code', pairing.display, '--name', 'Box', '--all', '--no-run'], { hermes: root, configDir: cfgDir }); assert.equal(await pr.done, 0, pr.out);
  const cfgFile = path.join(cfgDir, 'connector.json'), cfg = await readJson(cfgFile);
  if (gateway) { cfg.uiGatewayCommand = REAL ? REAL.cmd : [process.execPath, FAKE]; if (REAL?.cwd) cfg.uiGatewayCwd = REAL.cwd; } else cfg.uiGateway = 'off';
  if (REAL?.config) await writeFile(path.join(root, 'config.yaml'), REAL.config);
  await writeFile(cfgFile, JSON.stringify(cfg));
  const run = runConnector(t, ['run'], { hermes: root, configDir: cfgDir });
  const machine = await waitFor(async () => (await (await call('/api/machines')).json()).machines.find((m) => m.online)); assert.ok(machine, run.out);
  const ui = server.connectors.ui(machine.id); assert.ok(ui);
  const events = []; ui.subscribe((agent, ev) => events.push({ agent, ...ev }));
  const until = (pred, o = { tries: 150, ms: 100 }) => waitFor(async () => events.find(pred) ?? null, o);
  return { server, ui, events, until, run, machine, call, base, agent: 'default' };
}
