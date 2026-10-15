// Revocation and persistence races on the bot API. A store write (or load) is held at the filesystem so a second operation can queue
// behind it; every hub here is a real createHub on loopback, and every test asserts the hold actually engaged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { bootBot, bootHub, member, addBot } from './bot-helpers.js';

const readFileNow = fsp.readFile, readdirNow = fsp.readdir, statNow = fsp.stat;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userMessage = (text, extra = {}) => ({ messages: [{ role: 'user', content: text }], ...extra });
const exists = (f) => statNow(f).then(() => true, () => false);

async function findStore(dir, botId) {
  const tail = path.join('bot', `${botId}.json`);
  for (const e of await readdirNow(dir, { recursive: true })) if (e.endsWith(tail)) return path.join(dir, e);
  return null;
}
const readJson = async (file) => JSON.parse(await readFileNow(file, 'utf8'));
const persisted = async (dir, botId, chat, text) => (await readJson(await findStore(dir, botId))).messages[chat].some((m) => m.text === text);

/** Replaces fs/promises rename/readFile so the next call on `file` waits for release(); call it before booting the hub so teardown releases a stuck hold first. */
function holdFs(t) {
  const real = { rename: fsp.rename, readFile: fsp.readFile };
  let armed = null; const gates = [];
  const wrap = (op) => async (...args) => {
    const a = armed, target = op === 'rename' ? args[1] : args[0];
    if (a && a.op === op && String(target) === a.file) { armed = null; a.engage(); await a.gate; }
    return real[op](...args);
  };
  fsp.rename = wrap('rename'); fsp.readFile = wrap('readFile'); syncBuiltinESMExports();
  t.after(() => { for (const g of gates) g(); fsp.rename = real.rename; fsp.readFile = real.readFile; syncBuiltinESMExports(); });
  return {
    arm(op, file) {
      let engage, release; const gate = new Promise((r) => { release = r; });
      const engaged = new Promise((r) => { engage = r; });
      armed = { op, file, engage, gate };
      const held = Promise.race([engaged, sleep(4000).then(() => { throw new Error(`the ${op} hold on ${file} never engaged`); })]);
      held.catch(() => {});
      gates.push(release);
      return { held, release: () => { armed = null; release(); } };
    },
  };
}

const settledWithin = (p, ms) => Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);
const asBot = async (b) => {
  const c = await b.connect(); await c.next((x) => x.t === 'hello');
  const first = await (await b.h.call('/api/agents/helper/messages', { token: b.owner, data: userMessage('hello') })).json();
  await c.next((x) => x.t === 'message.new');
  return { c, chat: first.session_id };
};
const sendFrame = (c, id, chat, text) => c.send({ t: 'message.send', id, chat_id: chat, text });
const okRes = (c, id) => c.texts.find((x) => typeof x === 'object' && x.t === 'res' && x.id === id && x.ok === true);

for (const [kind, call, status, code, reason] of [
  ['revoke', (b) => b.h.call('/api/agents/helper/bot-token', { method: 'DELETE', token: b.owner }), 200, 4001, 'revoked'],
  ['rotation', (b) => b.h.call('/api/agents/helper/bot-token', { token: b.owner, data: {} }), 201, 4001, 'rotated'],
]) {
  test(`R1 ${kind} fences a bot write queued behind an in-flight write`, async (t) => {
    const fs = holdFs(t), b = await bootBot(t), { c, chat } = await asBot(b), file = await findStore(b.h.dir, b.botId);
    const hold = fs.arm('rename', file);
    const u2 = b.h.call('/api/agents/helper/messages', { token: b.owner, data: userMessage('u2', { session_id: chat }) });
    await hold.held;
    sendFrame(c, 's1', chat, 'after-revoke'); await sleep(50);
    const change = call(b), answeredWhileHeld = await settledWithin(change, 300);
    t.diagnostic(`${kind} answered while the write was held: ${answeredWhileHeld}`);
    assert.equal((await c.waitClose()).code, code, reason);
    hold.release();
    assert.equal((await u2).status, 202); assert.equal((await change).status, status);
    await sleep(150);
    assert.equal(await persisted(b.h.dir, b.botId, chat, 'after-revoke'), false, 'the write queued before the change was applied after it');
    assert.equal(okRes(c, 's1'), undefined, 'the bot was told the write succeeded');
  });
}

test('R2 revoke answers only after a bot write that is already committing', async (t) => {
  const fs = holdFs(t), b = await bootBot(t), { c, chat } = await asBot(b), file = await findStore(b.h.dir, b.botId);
  const hold = fs.arm('rename', file);
  sendFrame(c, 's1', chat, 'in-flight'); await hold.held;
  const revoke = b.h.call('/api/agents/helper/bot-token', { method: 'DELETE', token: b.owner });
  assert.equal(await settledWithin(revoke, 300), false, 'revoke answered while a write was still committing');
  hold.release();
  assert.equal((await revoke).status, 200);
  assert.equal(await persisted(b.h.dir, b.botId, chat, 'in-flight'), true, 'the committing write finished before the answer');
  const after = await readFileNow(file, 'utf8'); await sleep(150);
  assert.equal(await readFileNow(file, 'utf8'), after, 'nothing wrote after the revoke answered');
});

test('R3 owner disabling a member fences that member bot', async (t) => {
  const fs = holdFs(t), h = await bootHub(t), alice = await member(h), mbot = await addBot(t, h, 'mbot', { token: alice.token });
  const c = await mbot.connect(); await c.next((x) => x.t === 'hello');
  const first = await (await h.call('/api/agents/mbot/messages', { token: alice.token, data: userMessage('hello') })).json(), chat = first.session_id;
  await c.next((x) => x.t === 'message.new');
  const file = await findStore(h.dir, mbot.botId), hold = fs.arm('rename', file);
  const u2 = h.call('/api/agents/mbot/messages', { token: alice.token, data: userMessage('u2', { session_id: chat }) });
  await hold.held;
  sendFrame(c, 's1', chat, 'after-disable'); await sleep(50);
  const disable = h.call(`/api/admin/users/${alice.id}`, { method: 'PATCH', data: { disabled: true } });
  t.diagnostic(`disable answered while held: ${await settledWithin(disable, 300)}`);
  assert.equal((await c.waitClose()).code, 4003);
  hold.release();
  assert.equal((await u2).status, 202); assert.equal((await disable).status, 200);
  await sleep(150);
  assert.equal(await persisted(h.dir, mbot.botId, chat, 'after-disable'), false);
  assert.equal(okRes(c, 's1'), undefined);
});

test('R4 a replaced connection cannot apply a write queued before its replacement', async (t) => {
  const fs = holdFs(t), b = await bootBot(t), { c, chat } = await asBot(b), file = await findStore(b.h.dir, b.botId);
  const hold = fs.arm('rename', file);
  const u2 = b.h.call('/api/agents/helper/messages', { token: b.owner, data: userMessage('u2', { session_id: chat }) });
  await hold.held;
  sendFrame(c, 's1', chat, 'from-old'); await sleep(50);
  const c2 = await b.connect(); await c2.next((x) => x.t === 'hello');
  assert.equal((await c.waitClose()).code, 4009);
  hold.release();
  assert.equal((await u2).status, 202);
  await sleep(150);
  assert.equal(await persisted(b.h.dir, b.botId, chat, 'from-old'), false, 'the replaced connection wrote after it was replaced');
  assert.equal(okRes(c, 's1'), undefined);
});

test('R5 deleting an agent while its store is loading cannot resurrect the store', async (t) => {
  const fs = holdFs(t), b = await bootBot(t), file = path.join(b.h.dir, 'bot', `${b.botId}.json`);
  assert.equal((await b.h.call('/api/agents/helper/messages', { token: b.owner, data: userMessage('before') })).status, 202);
  assert.equal(await exists(file), true);
  await b.h.restart();
  const hold = fs.arm('readFile', file);
  const late = b.h.call('/api/agents/helper/messages', { token: b.owner, data: userMessage('late') });
  await hold.held;
  assert.equal((await b.h.call('/api/connections/helper', { method: 'DELETE', token: b.owner })).status, 200);
  hold.release();
  const res = await late;
  assert.notEqual(res.status, 202, 'a message was accepted for a deleted agent');
  await sleep(150);
  assert.equal(await exists(file), false, 'the deleted agent store file came back');
});

test('R6 (hypothesis disproved, expected to pass before the fix) the per-connection pump stops at close, so later frames are never applied', async (t) => {
  const fs = holdFs(t), b = await bootBot(t), { c, chat } = await asBot(b), file = await findStore(b.h.dir, b.botId);
  const hold = fs.arm('rename', file);
  sendFrame(c, 's1', chat, 'first'); await hold.held;
  sendFrame(c, 's2', chat, 'queued-2'); sendFrame(c, 's3', chat, 'queued-3'); await sleep(50);
  const revoke = b.h.call('/api/agents/helper/bot-token', { method: 'DELETE', token: b.owner });
  await settledWithin(revoke, 300);
  assert.equal((await c.waitClose()).code, 4001);
  hold.release();
  assert.equal((await revoke).status, 200);
  await sleep(150);
  assert.equal(await persisted(b.h.dir, b.botId, chat, 'queued-2'), false);
  assert.equal(await persisted(b.h.dir, b.botId, chat, 'queued-3'), false);
  assert.equal(okRes(c, 's2'), undefined); assert.equal(okRes(c, 's3'), undefined);
});
