// FOXFLEET_BOT_AGENTS (0.3.12): per-agent rollout gate for the bot API (e.g. only "sumi-native").
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootHub, upgradeStatus } from './bot-helpers.js';

const addBot = (h, name) => h.call('/api/connections', { data: { kind: 'hermes', connection: 'bot', name } });
const mint = (h, name) => h.call(`/api/agents/${name}/bot-token`, { data: {} });

test('gate set: only listed agents can become bots, mint tokens and connect', { timeout: 30_000 }, async (t) => {
  const h = await bootHub(t, { hubOptions: { botAgents: ' sumi-native ,' } });
  const refused = await addBot(h, 'helper'); assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /not enabled for this agent/);
  assert.equal((await addBot(h, 'sumi-native')).status, 201);
  const r = await mint(h, 'sumi-native'); assert.equal(r.status, 201);
  const { token } = await r.json();
  assert.equal(await upgradeStatus(h.port, { token }), 101);
});

test('gate added later: an existing bot that is not listed is refused everywhere; removing the gate restores it', { timeout: 30_000 }, async (t) => {
  const hubOptions = {};
  const h = await bootHub(t, { hubOptions });
  assert.equal((await addBot(h, 'helper')).status, 201);
  const { token } = await (await mint(h, 'helper')).json();
  assert.equal(await upgradeStatus(h.port, { token }), 101, 'control: no gate');
  hubOptions.botAgents = 'sumi-native'; await h.restart();
  assert.equal(await upgradeStatus(h.port, { token }), 401, 'socket');
  const rpc = await fetch(`${h.base}/api/bot/rpc`, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ t: 'ping', id: 'p' }) });
  assert.equal(rpc.status, 401, 'http rpc'); await rpc.body?.cancel();
  const again = await mint(h, 'helper'); assert.equal(again.status, 403, 'cannot re-mint'); await again.body?.cancel();
  delete hubOptions.botAgents; await h.restart();
  assert.equal(await upgradeStatus(h.port, { token }), 101, 'gate removed: the old token works again');
});
