// FOXFLEET_BOT_API off (the default): nothing of the bot API exists, and saved bot agents fail safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readdir } from 'node:fs/promises';
import { bootHub } from './bot-helpers.js';

const upgradeStatus = (port, path = '/api/bot/ws') => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: foxfleet.bot.v1\r\nAuthorization: Bot ffb_${'A'.repeat(43)}\r\n\r\n`));
  let data = ''; s.on('data', (c) => { data += c; if (data.includes('\r\n')) { s.destroy(); resolve(Number(data.split(' ')[1])); } }); s.on('error', reject);
});

test('flag off: no socket, no token route, bot mode rejected, no feature flag, no files', async (t) => {
  const h = await bootHub(t, { botApi: false });
  assert.equal(await upgradeStatus(h.port), 404);
  assert.equal((await h.call('/api/agents/x/bot-token', { data: {} })).status, 404);
  const mode = await h.call('/api/connections', { data: { kind: 'hermes', connection: 'bot', name: 'helper' } });
  assert.equal(mode.status, 400); assert.equal((await mode.json()).error, 'Invalid connection mode');
  const auth = await (await h.call('/api/auth')).json(); assert.ok(!auth.hub.features.includes('botApi'));
  const names = await readdir(h.dir); assert.ok(!names.includes('bot'), 'no bot/ directory'); assert.ok(!names.includes('tokens.json'));
});

const BOT_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const seeded = { version: 3, machines: [
  { name: 'saved-bot', connection: 'bot', profile: 'default', botId: BOT_ID },
  { name: 'desk', connection: 'direct', host: '127.0.0.1', dashboardPort: 9, apiServerPort: 9 }] };

test('flag off: a saved bot agent loads, shows offline/disabled and every route answers 503 bot_disabled', async (t) => {
  const h = await bootHub(t, { botApi: false, seed: seeded });
  const list = await h.call('/api/agents'); assert.equal(list.status, 200);
  const bot = (await list.json()).agents.find((a) => a.name === 'saved-bot');
  assert.equal(bot.status, 'offline'); assert.equal(bot.online, false); assert.equal(bot.chatReady, false);
  assert.equal(bot.checks.bot.ok, false); assert.match(bot.checks.bot.message, /disabled/i);
  for (const [route, data] of [['messages', { messages: [{ role: 'user', content: 'hi' }] }], ['chat', { messages: [{ role: 'user', content: 'hi' }] }], ['sessions', undefined], ['sessions/abc/messages', undefined], ['runs', undefined], ['native', undefined], ['files', undefined], ['skills', undefined]]) {
    const r = await h.call(`/api/agents/saved-bot/${route}`, { data });
    assert.equal(r.status, 503, route); assert.equal((await r.json()).code, 'bot_disabled', route);
  }
  const direct = await h.call('/api/agents/desk/sessions'); assert.equal(direct.status, 502, 'a direct agent still reaches its (dead) upstream');
  assert.ok(!(await readdir(h.dir)).includes('bot'));
});
