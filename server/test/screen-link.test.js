// A screen-only machine tunnels one desktop onto an existing bot. It must not publish a second chat agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockHermes } from './fixtures.js';
import { bootHub, addBot } from './bot-helpers.js';
import { fakeHermesHome, runConnector, tmpDir, waitFor } from './machine-helpers.js';

test('screen-only pairing links one bot and does not create profile agents', async (t) => {
  const mock = await mockHermes(t), root = await fakeHermesHome(t, mock);
  const h = await bootHub(t), cfgDir = await tmpDir();
  await addBot(t, h, 'sumi-native');
  await addBot(t, h, 'rose-native');
  const pairing = await (await h.call('/api/machines/pairing', { data: { screenOnly: true, screenAgent: 'sumi-native' } })).json();
  assert.match(pairing.code, /^[A-Z2-9]{10}$/);
  const pair = runConnector(t, ['pair', '--hub', h.base, '--code', pairing.code, '--name', 'Sumi', '--profiles', 'default', '--no-run', '--dashboard-port', String(mock.connection.dashboardPort)], { hermes: root, configDir: cfgDir });
  assert.equal(await pair.done, 0, pair.out);
  const run = runConnector(t, ['run'], { hermes: root, configDir: cfgDir });
  const linked = await waitFor(async () => {
    const agents = (await h.call('/api/agents')).ok ? (await (await h.call('/api/agents')).json()).agents : null;
    const sumi = agents?.find((a) => a.name === 'sumi-native');
    return sumi?.capabilities?.screen ? agents : null;
  });
  assert.ok(linked, run.out);
  assert.deepEqual(linked.map((a) => a.name).sort(), ['rose-native', 'sumi-native']);
  assert.equal(linked.find((a) => a.name === 'rose-native').capabilities.screen, false);
  assert.equal(linked.find((a) => a.name === 'sumi-native').capabilities.screen, true);
  assert.equal((await (await h.call('/api/machines')).json()).machines[0].screenOnly, true);
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 2500);
  let status = 'hung';
  try {
    status = (await fetch(h.base + '/api/agents/sumi-native/screen/status', { headers: { Authorization: `Bearer ${h.token}` }, signal: ctrl.signal })).status;
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  clearTimeout(timer);
  assert.notEqual(status, 404, 'linked screen must leave the bot choke point');
  assert.equal((await h.call('/api/agents/rose-native/screen/status')).status, 404);
  const leaked = await (await h.call('/api/connections', { data: { kind: 'hermes', connection: 'bot', name: 'sneak', screenMachine: 'a'.repeat(32) } })).json();
  assert.equal(leaked.connection.screenMachine, undefined);
  const machines = (await (await h.call('/api/machines')).json()).machines;
  assert.equal((await h.call('/api/machines/' + machines[0].id, { method: 'DELETE' })).status, 200);
  const after = (await (await h.call('/api/agents')).json()).agents.find((a) => a.name === 'sumi-native');
  assert.equal(after.capabilities.screen, false);
});
