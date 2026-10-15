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
  hubOptions.botAgents = '*'; await h.restart();
  assert.equal(await upgradeStatus(h.port, { token }), 101, 'gate widened to "*": the old token works again');
});

test('deny by default: flag on and FOXFLEET_BOT_AGENTS unset allows no bot agent, and warns loudly at start', { timeout: 30_000 }, async (t) => {
  const warned = [], orig = console.warn; console.warn = (...a) => { warned.push(a.join(' ')); };
  t.after(() => { console.warn = orig; });
  const saved = process.env.FOXFLEET_BOT_AGENTS; delete process.env.FOXFLEET_BOT_AGENTS;
  t.after(() => { if (saved !== undefined) process.env.FOXFLEET_BOT_AGENTS = saved; });
  const h = await bootHub(t, { hubOptions: { botAgents: undefined } });
  console.warn = orig;
  assert.ok(warned.some((w) => /FOXFLEET_BOT_AGENTS is unset or empty: NO bot agent is allowed/.test(w)), 'loud start warning');
  const r = await addBot(h, 'sumi-native'); assert.equal(r.status, 403); await r.body?.cancel();
  const e = await bootHub(t, { hubOptions: { botAgents: ' , ' } });
  const r2 = await addBot(e, 'sumi-native'); assert.equal(r2.status, 403, 'empty list is deny too'); await r2.body?.cancel();
});
