// Hardening regressions for the bot API: effective default limits, constant-time token lookup, client_id session binding
// and retention, per-bot map cleanup, and directory fsync. Every hub here is a real createHub on loopback.
// Tests marked SYNTHETIC FIXTURE write a bot store or token file by hand (stale records, filled backlogs, malformed hashes)
// because reaching those states through the API would take thousands of requests or a 24 h wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import fsp from 'node:fs/promises';
import crypto, { createHash, randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { bootBot, bootHub } from './bot-helpers.js';
import { createBotApi } from '../bot-api.js';
import * as storeModule from '../bot-store.js';

const storeFile = (b) => path.join(b.h.dir, 'bot', `${b.botId}.json`);
const readStore = async (b) => JSON.parse(await readFile(storeFile(b), 'utf8'));
const userMessage = (text, extra = {}) => ({ messages: [{ role: 'user', content: text }], ...extra });
const chatId = (n) => 'fc_' + String(n).padStart(16, 'A').replace(/[^A-Za-z0-9_-]/g, 'A');
const HOUR = 3600 * 1000;

/** SYNTHETIC FIXTURE: a bot store holding `chats` chats, `messagesIn0` messages in the first one and `events` unacknowledged events. */
function syntheticStore({ chats = 1, messagesIn0 = 0, events = 0, clients = {} } = {}) {
  const now = Date.now(), d = { v: 1, next_event_id: events + 1, acked: 0, events: [], chats: {}, messages: {}, idem: {}, clients, commands: [] };
  for (let i = 0; i < chats; i++) { const id = chatId(i); d.chats[id] = { id, title: `c${i}`, created: now, updated: now }; d.messages[id] = []; }
  const first = chatId(0);
  for (let i = 0; i < messagesIn0; i++) d.messages[first].push({ id: 'fm_' + String(i).padStart(16, 'B'), role: 'user', text: `m${i}`, ts: now, user: { id: 'u', name: 'u' } });
  for (let i = 1; i <= events; i++) d.events.push({ id: i, chat_id: first, message_id: 'fm_' + String(i).padStart(16, 'E'), user: { id: 'u', name: 'u' }, text: 'x', date: now });
  return d;
}
async function withStore(t, d) { const b = await bootBot(t); await writeFile(storeFile(b), JSON.stringify(d)); await b.h.restart(); return b; }

// ---------------------------------------------------------------- P1: default limits

test('limits: botLimits fills omitted or undefined caps with the documented defaults (1000 / 500 / 2000)', () => {
  assert.equal(typeof storeModule.botLimits, 'function', 'bot-store exports botLimits');
  const want = { maxUnacked: 1000, maxChats: 500, maxMessagesPerChat: 2000 };
  for (const input of [undefined, {}, { maxUnacked: undefined, maxChats: undefined, maxMessagesPerChat: undefined }]) {
    const l = storeModule.botLimits(input); for (const [k, v] of Object.entries(want)) assert.equal(l[k], v, `${k} for ${JSON.stringify(input)}`);
  }
  assert.equal(storeModule.botLimits({ maxChats: 2 }).maxChats, 2, 'a valid explicit cap overrides');
  assert.equal(storeModule.botLimits({ maxChats: 2 }).maxUnacked, 1000, 'the others keep their default');
  for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, '10', null, 2 ** 53]) assert.throws(() => storeModule.botLimits({ maxUnacked: bad }), /limit/i, `rejects ${String(bad)}`);
});

test('limits: botStore() without options enforces the default caps (not undefined, which disabled every check)', () => {
  const s = storeModule.botStore(path.join(os.tmpdir(), 'unused-' + randomBytes(4).toString('hex') + '.json'));
  assert.equal(s.limits.maxUnacked, 1000); assert.equal(s.limits.maxChats, 500); assert.equal(s.limits.maxMessagesPerChat, 2000);
  const passed = storeModule.botStore(path.join(os.tmpdir(), 'unused.json'), { maxUnacked: undefined, maxChats: undefined, maxMessagesPerChat: undefined });
  assert.equal(passed.limits.maxUnacked, 1000); assert.equal(passed.limits.maxChats, 500); assert.equal(passed.limits.maxMessagesPerChat, 2000);
});

test('limits (SYNTHETIC FIXTURE): a default hub refuses the 1001st unacknowledged event with 503 bot_backlog_full', async (t) => {
  const b = await withStore(t, syntheticStore({ events: 999 }));
  const ok = await b.h.call('/api/agents/helper/messages', { data: userMessage('number 1000', { session_id: chatId(0) }) });
  assert.equal(ok.status, 202, 'the 1000th still fits');
  const full = await b.h.call('/api/agents/helper/messages', { data: userMessage('number 1001', { session_id: chatId(0) }) });
  assert.equal(full.status, 503); assert.equal((await full.json()).code, 'bot_backlog_full'); assert.ok(full.headers.get('retry-after'));
  assert.equal((await readStore(b)).events.length, 1000, 'nothing written for the refused one');
});

test('limits (SYNTHETIC FIXTURE): a default hub refuses the 501st chat with 409 bot_chat_limit', async (t) => {
  const b = await withStore(t, syntheticStore({ chats: 499 }));
  assert.equal((await b.h.call('/api/agents/helper/sessions', { data: {} })).status, 201, 'the 500th chat still fits');
  const over = await b.h.call('/api/agents/helper/sessions', { data: {} });
  assert.equal(over.status, 409); assert.equal((await over.json()).code, 'bot_chat_limit');
  const viaMessage = await b.h.call('/api/agents/helper/messages', { data: userMessage('new chat please') });
  assert.equal(viaMessage.status, 409, 'a message that would open chat 501 is refused too');
  assert.equal(Object.keys((await readStore(b)).chats).length, 500);
});

test('limits (SYNTHETIC FIXTURE): a default hub keeps only the newest 2000 messages of a chat', async (t) => {
  const b = await withStore(t, syntheticStore({ messagesIn0: 2000 }));
  assert.equal((await b.h.call('/api/agents/helper/messages', { data: userMessage('newest', { session_id: chatId(0) }) })).status, 202);
  const list = (await readStore(b)).messages[chatId(0)];
  assert.equal(list.length, 2000); assert.equal(list[0].text, 'm1', 'the oldest was pruned'); assert.equal(list.at(-1).text, 'newest');
});

test('limits: createHub refuses invalid explicit caps instead of silently disabling them; valid overrides still apply', async (t) => {
  for (const bad of [0, -5, NaN, Infinity, 1.5]) {
    await assert.rejects(bootHub(t, { botOptions: { maxChats: bad }, setup: false }), /limit/i, `maxChats ${bad}`);
  }
  const b = await bootBot(t, { botOptions: { maxChats: 1 } });
  assert.equal((await b.h.call('/api/agents/helper/sessions', { data: {} })).status, 201);
  assert.equal((await b.h.call('/api/agents/helper/sessions', { data: {} })).status, 409);
});

// ---------------------------------------------------------------- token lookup

const sha = (v) => createHash('sha256').update(v).digest('hex');
const fakeToken = () => 'ffb_' + randomBytes(32).toString('base64url');

test('tokens: verify compares every well-formed stored hash with timingSafeEqual (no early exit) and skips malformed ones', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-tok-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tokens.json'), good = [fakeToken(), fakeToken(), fakeToken()];
  // SYNTHETIC FIXTURE: three real hashes plus malformed rows (short, upper-case, non-hex, empty).
  const rows = [...good.map((tok, i) => ({ hash: sha(tok), scope: 's', bot_id: 'b' + i, created: 1 })),
    { hash: 'abc', scope: 's', bot_id: 'x1', created: 1 }, { hash: sha('q').toUpperCase(), scope: 's', bot_id: 'x2', created: 1 },
    { hash: 'z'.repeat(64), scope: 's', bot_id: 'x3', created: 1 }, { hash: '', scope: 's', bot_id: 'x4', created: 1 }];
  const raw = JSON.stringify({ v: 1, tokens: rows }); await writeFile(file, raw);
  const idx = storeModule.tokenIndex(file); await idx.ready();
  const real = crypto.timingSafeEqual; let calls = 0;
  crypto.timingSafeEqual = (a, b) => { calls++; assert.equal(a.length, 32); assert.equal(b.length, 32); return real(a, b); }; syncBuiltinESMExports();
  t.after(() => { crypto.timingSafeEqual = real; syncBuiltinESMExports(); });
  assert.equal(idx.verify(fakeToken()), null, 'unknown token'); assert.equal(calls, 3, 'one constant-time compare per well-formed hash');
  calls = 0; assert.deepEqual(idx.verify(good[0]), { scope: 's', botId: 'b0' }); assert.equal(calls, 3, 'a match does not stop the scan');
  calls = 0; assert.deepEqual(idx.verify(good[2]), { scope: 's', botId: 'b2' }); assert.equal(calls, 3);
  for (const junk of [undefined, null, 5, '', 'ffb_short', 'Bot ' + good[0], good[0] + 'x']) assert.equal(idx.verify(junk), null);
  assert.equal(await readFile(file, 'utf8'), raw, 'the file is never rewritten by a lookup');
});

test('tokens (SYNTHETIC FIXTURE): malformed stored hashes never admit anything and never break the legitimate token', async (t) => {
  const b = await bootBot(t), file = path.join(b.h.dir, 'bot', 'tokens.json'), doc = JSON.parse(await readFile(file, 'utf8'));
  doc.tokens.push({ hash: 'abc', scope: doc.tokens[0].scope, bot_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', created: 1 }, { hash: 'Z'.repeat(64), scope: doc.tokens[0].scope, bot_id: 'bbbbbbbbbbbbbbbbbbbbbbbb', created: 1 });
  const raw = JSON.stringify(doc); await writeFile(file, raw); await b.h.restart();
  const c = await b.connect(); await c.next((x) => x.t === 'hello'); c.end();
  const { upgradeStatus } = await import('./bot-helpers.js');
  assert.equal(await upgradeStatus(b.h.port, { token: fakeToken() }), 401);
  assert.equal(await readFile(file, 'utf8'), raw, 'token file untouched');
});

// ---------------------------------------------------------------- client_id binding and retention

test('client_id: the same client_id and text for a DIFFERENT chat is a 409 conflict on /messages and /chat, never the old chat', async (t) => {
  const b = await bootBot(t);
  const a = (await (await b.h.call('/api/agents/helper/sessions', { data: {} })).json()).id, other = (await (await b.h.call('/api/agents/helper/sessions', { data: {} })).json()).id;
  const first = await b.h.call('/api/agents/helper/messages', { data: userMessage('same text', { session_id: a, client_id: 'client-bind-0001' }) });
  assert.equal(first.status, 202);
  const elsewhere = await b.h.call('/api/agents/helper/messages', { data: userMessage('same text', { session_id: other, client_id: 'client-bind-0001' }) });
  assert.equal(elsewhere.status, 409); assert.equal((await elsewhere.json()).code, 'client_id_conflict');
  const viaChat = await b.h.call('/api/agents/helper/chat', { data: userMessage('same text', { session_id: other, client_id: 'client-bind-0001' }) });
  assert.equal(viaChat.status, 409); assert.equal((await viaChat.json()).code, 'client_id_conflict');
  const q = await (await b.h.call(`/api/agents/helper/queue?session_id=${other}`)).json(); assert.equal(q.active_run, null, 'no run left open for the other chat');
  const same = await b.h.call('/api/agents/helper/messages', { data: userMessage('same text', { session_id: a, client_id: 'client-bind-0001' }) });
  assert.equal(same.status, 200); assert.equal((await same.json()).session_id, a, 'retry to the same chat is still a duplicate');
  assert.equal((await readStore(b)).messages[other].length, 0);
});

test('client_id: a retry with no session_id returns the chat first assigned, on /messages and on /chat', async (t) => {
  const b = await bootBot(t);
  const first = await (await b.h.call('/api/agents/helper/messages', { data: userMessage('opening line', { client_id: 'client-open-0001' }) })).json();
  const again = await (await b.h.call('/api/agents/helper/messages', { data: userMessage('opening line', { client_id: 'client-open-0001' }) })).json();
  assert.equal(again.duplicate, true); assert.equal(again.session_id, first.session_id);
  const ctl = new AbortController(); t.after(() => ctl.abort());
  const chat = await fetch(b.h.base + '/api/agents/helper/chat', { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${b.h.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(userMessage('opening line', { client_id: 'client-open-0001' })) });
  assert.equal(chat.status, 200); assert.equal(chat.headers.get('x-hermes-session-id'), first.session_id, 'the stream follows the original chat');
  ctl.abort();
  const store = await readStore(b); assert.equal(Object.keys(store.chats).length, 1, 'no phantom chat'); assert.equal(store.events.length, 1, 'the bot hears once');
});

test('client_id (SYNTHETIC FIXTURE): records older than 24 h expire even when nothing else writes; younger ones still dedupe', async (t) => {
  const old = Date.now() - 25 * HOUR, young = Date.now() - 23 * HOUR, text = 'hello again';
  const rec = (at) => ({ chat_id: chatId(0), message_id: 'fm_' + 'O'.repeat(16), text_hash: sha(text), created: at, event_id: 0, at });
  const b = await withStore(t, syntheticStore({ clients: { 'c:client-old-00001': rec(old), 'c:client-new-00001': rec(young) } }));
  const expired = await b.h.call('/api/agents/helper/messages', { data: userMessage(text, { session_id: chatId(0), client_id: 'client-old-00001' }) });
  assert.equal(expired.status, 202, 'a 25 h old client_id is accepted as new'); assert.notEqual((await expired.json()).message.id, 'fm_' + 'O'.repeat(16));
  const kept = await b.h.call('/api/agents/helper/messages', { data: userMessage(text, { session_id: chatId(0), client_id: 'client-new-00001' }) });
  assert.equal(kept.status, 200); assert.equal((await kept.json()).duplicate, true);
});

// ---------------------------------------------------------------- per-bot maps and durability

test('maps: removeAgent and revokeScope drop the cached store and rate bucket of the bots they remove', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-maps-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const agents = [{ name: 'a', connection: 'bot', botId: 'a'.repeat(24) }, { name: 'b', connection: 'bot', botId: 'b'.repeat(24) }];
  const reg = { dir, store: { all: () => agents }, activity: { touch() {} } };
  const api = await createBotApi({ dataDir: dir, scopeReg: async () => reg, ownerOf: () => ({ id: 's' }), runs: {} });
  t.after(() => api.close());
  assert.equal(typeof api.sizes, 'function', 'createBotApi exposes sizes() for leak checks');
  const list = (m) => api.route({ req: { method: 'GET' }, res: {}, parts: ['api', 'agents', m.name, 'sessions'], url: new URL('http://hub/'), m, scope: 's', reg, sendJson() {} });
  await list(agents[0]); await list(agents[1]);
  assert.equal(api.sizes().stores, 2);
  await api.removeAgent(agents[0], reg); assert.equal(api.sizes().stores, 1, 'removeAgent forgets its store');
  await api.revokeScope('s'); assert.equal(api.sizes().stores, 0, 'revokeScope forgets every store of the account'); assert.equal(api.sizes().buckets, 0);
});

test('durability: a store write fsyncs the file and then its directory (POSIX), so the rename itself survives power loss', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-fsync-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sub', 'x.json'), opened = [], real = fsp.open;
  fsp.open = async (p, ...rest) => { opened.push([String(p), rest[0]]); return real(p, ...rest); }; syncBuiltinESMExports();
  t.after(() => { fsp.open = real; syncBuiltinESMExports(); });
  const f = storeModule.jsonFile(file, { fresh: () => ({ n: 0 }), valid: (v) => typeof v?.n === 'number' }); await f.load();
  await f.mutate((d) => { d.n = 1; });
  assert.ok(opened.some(([p]) => p === path.dirname(file)), 'the parent directory was opened for fsync: ' + JSON.stringify(opened));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).n, 1);
});
