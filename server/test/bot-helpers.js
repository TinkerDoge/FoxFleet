// Shared harness for the bot API tests: a real hub on loopback port 0, a private temp dir, full teardown.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createHub } from '../index.js';
import { frameParser, acceptKey } from '../ws.js';

export const PW = 'correct horse battery';

export async function bootHub(t, { botApi = true, botOptions, dir, seed, hubOptions = {}, setup = true } = {}) {
  const own = !dir;
  dir ??= await mkdtemp(path.join(os.tmpdir(), 'foxfleet-bot-'));
  const configPath = path.join(dir, 'config.json');
  if (seed) await writeFile(configPath, JSON.stringify(seed));
  const h = { dir, configPath, botApi, token: '' };
  const start = async () => {
    h.server = await createHub({ configPath, botApi, botOptions, botAgents: '*', ...hubOptions }); // '*': the gate is deny-by-default
    await new Promise((r) => h.server.listen(0, '127.0.0.1', r));
    h.port = h.server.address().port; h.base = `http://127.0.0.1:${h.port}`;
  };
  const stop = async () => { h.server.closeAllConnections(); await new Promise((r) => h.server.close(r)); await new Promise((r) => setTimeout(r, 20)); };
  h.restart = async () => { await stop(); await start(); };
  h.stop = stop;
  h.call = (route, { token = h.token, data, method = data === undefined ? 'GET' : 'POST', headers = {} } = {}) => fetch(h.base + route, {
    method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  await start();
  let stopped = false;
  t.after(async () => { if (!stopped) { stopped = true; await stop(); } if (own) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  if (setup) {
    const r = await h.call('/api/auth/setup', { token: '', data: { username: 'owner1', password: PW, client: 'app' } });
    assert.equal(r.status, 200); h.token = (await r.json()).token;
  }
  return h;
}

/** A second account, registered through an invite. Returns { token, id, username }. */
export async function member(h, username = 'alice') {
  assert.equal((await h.call('/api/admin/settings', { method: 'PUT', data: { registration: 'invite' } })).status, 200);
  const inv = await (await h.call('/api/admin/invites', { data: {} })).json();
  const r = await h.call('/api/auth/register', { token: '', data: { username, password: PW, invite: inv.code, client: 'app' } });
  assert.equal(r.status, 200); const body = await r.json();
  return { token: body.token, id: body.user.id, username };
}

/** Raw client frame builder; `declare` lies about the payload length (to test limits without sending the body). */
export function wsFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = true, rsv = 0, declare } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)), len = declare ?? data.length, head = [(fin ? 0x80 : 0) | rsv | opcode];
  let ext = Buffer.alloc(0);
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) { head.push((mask ? 0x80 : 0) | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
  else { head.push((mask ? 0x80 : 0) | 127); ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, data]);
  const key = randomBytes(4), body = Buffer.from(data); for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), ext, key, body]);
}
export const textFrame = (obj) => wsFrame(1, typeof obj === 'string' ? obj : JSON.stringify(obj));
export const closeFrame = (code, reason = '') => { const b = Buffer.alloc(2); b.writeUInt16BE(code); return wsFrame(8, Buffer.concat([b, Buffer.from(reason)])); };

/**
 * Raw WebSocket client over `net`. Buffers every byte from the very first one (including what follows the 101 in the same packet),
 * so the server's immediate hello is never lost. `headers` entries set to undefined are removed from the default handshake.
 */
export function rawWs(port, { headers = {}, path: reqPath = '/api/bot/ws', extra, token, key = randomBytes(16).toString('base64'), pong = true, echoClose = true } = {}) {
  const defaults = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1', ...(token ? { Authorization: `Bot ${token}` } : {}) };
  const all = { ...defaults, ...headers }; for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: !echoClose }), parse = frameParser(32 * 1024 * 1024);
  const c = { socket, status: 0, headers: {}, frames: [], texts: [], close: null, key, ended: false }, waiters = new Set();
  let buf = Buffer.alloc(0), opened = false, resolveClosed; const closed = new Promise((r) => { resolveClosed = r; });
  c.closed = closed; c.open = new Promise((r) => { c.settled = r; });
  const wake = () => { for (const w of [...waiters]) w(); };
  const finish = (code, reason = '') => { if (!c.close) { c.close = { code, reason }; resolveClosed(c.close); wake(); } };
  const feed = (chunk) => {
    let frames; try { frames = parse(chunk); } catch { finish(1006, 'parse'); return; }
    for (const f of frames) {
      c.frames.push(f);
      if (f.opcode === 1) { const text = f.data.toString('utf8'); let obj; try { obj = JSON.parse(text); } catch { obj = undefined; } c.texts.push(obj ?? text); }
      else if (f.opcode === 9 && pong) socket.write(wsFrame(10, f.data));
      else if (f.opcode === 8) { finish(f.data.length >= 2 ? f.data.readUInt16BE(0) : 1005, f.data.subarray(2).toString()); if (echoClose && !socket.destroyed) socket.write(wsFrame(8, f.data.subarray(0, 2)), () => socket.end()); }
    }
    wake();
  };
  socket.on('data', (chunk) => {
    if (opened) return feed(chunk);
    buf = Buffer.concat([buf, chunk]); const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
    const lines = buf.subarray(0, end).toString().split('\r\n'); c.status = Number(lines[0].split(' ')[1]);
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); c.headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
    const rest = buf.subarray(end + 4); opened = true; c.settled(c.status);
    if (c.status === 101) feed(rest); else socket.end();
  });
  socket.on('close', () => { c.ended = true; if (!opened) c.settled(0); finish(1006, 'socket closed'); wake(); });
  socket.on('error', () => {});
  socket.on('connect', () => socket.write([`GET ${reqPath} HTTP/1.1`, ...Object.entries(all).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n')));
  if (extra) socket.on('connect', () => socket.write(extra));
  c.send = (obj) => socket.write(textFrame(obj));
  c.sendRaw = (b) => socket.write(b);
  c.until = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('timed out; texts=' + JSON.stringify(c.texts.slice(-5)) + ' close=' + JSON.stringify(c.close))); }, ms);
    const check = () => { const v = pred(c); if (v) { clearTimeout(timer); waiters.delete(check); resolve(v); } }; waiters.add(check); check();
  });
  c.next = (pred = () => true, ms) => c.until(() => c.texts.find((x) => typeof x === 'object' && pred(x)), ms);
  c.request = (frame, ms) => { c.send(frame); return c.next((x) => x.t === 'res' && x.id === frame.id, ms); };
  c.waitClose = (ms = 4000) => c.until((x) => x.close, ms);
  c.end = () => { if (!socket.destroyed) socket.destroy(); };
  c.status101 = async () => { await c.open; assert.equal(c.status, 101); return c; };
  return c;
}

/** The HTTP status a (refused) upgrade answers with. */
export async function upgradeStatus(port, options) { const c = rawWs(port, options); const status = await c.open; c.end(); return status; }

/** Opens a bot socket with a valid token and waits for the 101. Every socket opened is destroyed when the test ends. */
export async function botSocket(t, port, token, options = {}) {
  const c = rawWs(port, { token, ...options }); t.after(() => c.end());
  const status = await c.open; if (status !== 101) { c.end(); throw Object.assign(new Error('upgrade refused: ' + status), { status }); }
  return c;
}

/** A bare http server that hands every upgrade to acceptBotSocket (unit tests of the receiver). */
export async function wsFixture(t, accept, { checkHandshake, opts = {}, hello = { t: 'hello' } } = {}) {
  const fx = { messages: [], closes: [], conn: null, connections: 0 };
  const server = http.createServer((req, res) => res.end());
  server.on('upgrade', (req, socket, head) => {
    const bad = checkHandshake?.(req); if (bad) { socket.end(`HTTP/1.1 ${bad} Refused\r\nContent-Length: 0\r\n\r\n`); return; }
    fx.connections++; fx.socket = socket;
    fx.conn = accept(req, socket, head, { ...opts, onOpen: (conn) => { fx.conn = conn; if (hello) conn.send(hello); opts.onOpen?.(conn); }, onMessage: async (text, conn) => { fx.messages.push(text); await opts.onMessage?.(text, conn); }, onClose: (code, reason) => { fx.closes.push([code, reason]); opts.onClose?.(code, reason); } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); fx.port = server.address().port;
  t.after(async () => { fx.conn?.close?.(1001); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  fx.connect = async (options) => { const c = rawWs(fx.port, options); t.after(() => c.end()); await c.status101(); return c; };
  fx.until = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out waiting for the server side'); };
  return fx;
}
export { acceptKey };

/** A hub with one registered bot ("helper") and a minted token. */
export async function bootBot(t, options = {}, { name = 'helper', as } = {}) {
  const h = await bootHub(t, options);
  const token = as?.token ?? h.token;
  const r = await h.call('/api/connections', { token, data: { kind: 'hermes', connection: 'bot', name } }); assert.equal(r.status, 201);
  const minted = await h.call(`/api/agents/${name}/bot-token`, { token, data: {} }); assert.equal(minted.status, 201);
  const body = await minted.json();
  return { h, name, owner: token, token: body.token, botId: body.bot_id, connect: (opts) => botSocket(t, h.port, body.token, opts), remint: async () => (await (await h.call(`/api/agents/${name}/bot-token`, { token, data: {} })).json()).token };
}

/** Reads a fetch() SSE response incrementally: `events` is [{ event, data (parsed when JSON), raw, id }]. */
export function sseReader(res) {
  const reader = res.body.getReader(), dec = new TextDecoder(), events = [], waiters = new Set(); let buf = '', ended = false;
  const wake = () => { for (const w of [...waiters]) w(); };
  const done = (async () => {
    try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const e = { event: 'message', raw: block }; for (const line of block.split('\n')) { if (line.startsWith('event:')) e.event = line.slice(6).trim(); else if (line.startsWith('data:')) e.raw_data = (e.raw_data ?? '') + line.slice(5).trim(); else if (line.startsWith('id:')) e.id = line.slice(3).trim(); } try { e.data = JSON.parse(e.raw_data); } catch { e.data = e.raw_data; } events.push(e); wake(); } } } catch { /* aborted */ }
    ended = true; wake();
  })();
  const until = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error('timed out; events=' + JSON.stringify(events.slice(-6)))); }, ms);
    const check = () => { const v = pred(); if (v) { clearTimeout(timer); waiters.delete(check); resolve(v); } }; waiters.add(check); check();
  });
  return { events, done, get ended() { return ended; }, until,
    next: (pred, ms) => until(() => events.find(pred), ms),
    deltas: () => events.filter((e) => e.event === 'message' && e.data?.choices).map((e) => e.data.choices[0].delta.content),
    finished: (ms) => until(() => ended, ms),
    cancel: () => reader.cancel().catch(() => {}) };
}

/** Registers one more bot in an account's registry and mints its token. */
export async function addBot(t, h, name, { token = h.token } = {}) {
  assert.equal((await h.call('/api/connections', { token, data: { kind: 'hermes', connection: 'bot', name } })).status, 201);
  const minted = await (await h.call(`/api/agents/${name}/bot-token`, { token, data: {} })).json();
  return { name, token: minted.token, botId: minted.bot_id, account: token, connect: (opts) => botSocket(t, h.port, minted.token, opts) };
}
