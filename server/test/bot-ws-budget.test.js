// The bot WebSocket must not spend the per-IP login budget on authenticated reconnects (phase 1, task 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootBot, upgradeStatus, PW } from './bot-helpers.js';

const login = (h) => h.call('/api/auth/login', { token: '', data: { username: 'owner1', password: PW, client: 'app' } });

test('70 valid bot reconnects leave the login budget untouched', { timeout: 30_000 }, async (t) => {
  const b = await bootBot(t, { botOptions: { connectBurst: 200 } });
  for (let i = 0; i < 70; i++) assert.equal(await upgradeStatus(b.h.port, { token: b.token }), 101, `reconnect ${i}`);
  const r = await login(b.h); assert.equal(r.status, 200, 'a human can still log in from the same IP'); await r.body?.cancel();
});

test('bad bot tokens still spend the budget; a locked IP cannot slip a valid token through', { timeout: 30_000 }, async (t) => {
  const b = await bootBot(t, { botOptions: { connectBurst: 200 } }), bad = 'ffb_' + 'A'.repeat(43);
  let status = 0;
  for (let i = 0; i < 70 && status !== 429; i++) status = await upgradeStatus(b.h.port, { headers: { Authorization: `Bot ${bad}` } });
  assert.equal(status, 429, 'token guessing is throttled');
  assert.equal(await upgradeStatus(b.h.port, { token: b.token }), 429, 'valid token from a locked IP is refused');
});

test('a reconnect storm with a valid token hits the per-bot connect bucket (429), not the login budget', { timeout: 30_000 }, async (t) => {
  const b = await bootBot(t, { botOptions: { connectBurst: 3, connectPerMin: 1 } });
  const got = [];
  for (let i = 0; i < 5; i++) got.push(await upgradeStatus(b.h.port, { token: b.token }));
  assert.deepEqual(got, [101, 101, 101, 429, 429]);
  const r = await login(b.h); assert.equal(r.status, 200); await r.body?.cancel();
});
