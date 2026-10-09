// Minimal RFC 6455 helpers (zero dependencies): a JSON-RPC client for the Hermes gateway
// socket and the frame codec the tests' fake dashboard uses. The screen proxy itself never
// parses frames: it splices the two upgraded sockets byte-for-byte.
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';

export const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

export function encodeFrame(opcode, payload, mask = false) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length, head = [0x80 | opcode];
  let ext;
  if (len < 126) { head.push((mask ? 0x80 : 0) | len); ext = Buffer.alloc(0); }
  else if (len < 65536) { head.push((mask ? 0x80 : 0) | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
  else { head.push((mask ? 0x80 : 0) | 127); ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, data]);
  const key = randomBytes(4), body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), ext, key, body]);
}

// Incremental parser: push() bytes, get complete {opcode, data} messages (fragments joined).
export function frameParser(limit = 4 * 1024 * 1024) {
  let buf = Buffer.alloc(0), parts = [], partOp = 0;
  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]); const out = [];
    for (;;) {
      if (buf.length < 2) break;
      const fin = buf[0] & 0x80, opcode = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; const big = buf.readBigUInt64BE(2); if (big > BigInt(limit)) throw new Error('frame too large'); len = Number(big); off = 10; }
      if (len > limit) throw new Error('frame too large');
      const need = off + (masked ? 4 : 0) + len; if (buf.length < need) break;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const key = buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3]; }
      buf = buf.subarray(need);
      if (opcode >= 8) { out.push({ opcode, data: Buffer.from(data) }); continue; }
      if (opcode !== 0) partOp = opcode;
      parts.push(Buffer.from(data));
      if (fin) { out.push({ opcode: partOp, data: Buffer.concat(parts) }); parts = []; }
    }
    return out;
  };
}

// Client upgrade. Resolves to an emitter with send(text), close(); emits 'message' (string), 'close'.
export function wsConnect(url, { headers = {}, protocols = [], timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), secure = u.protocol === 'wss:' || u.protocol === 'https:';
    const key = randomBytes(16).toString('base64');
    const req = (secure ? https : http).request({ hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, method: 'GET', headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}) } });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('WebSocket connect timed out')); }, timeoutMs); timer.unref?.();
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('response', (res) => { clearTimeout(timer); res.resume(); reject(Object.assign(new Error('WebSocket upgrade refused'), { status: res.statusCode })); });
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers['sec-websocket-accept'] !== acceptKey(key)) { socket.destroy(); return reject(new Error('Bad WebSocket accept')); }
      const ws = new EventEmitter(), parse = frameParser(); let closed = false;
      const finish = (code) => { if (closed) return; closed = true; ws.emit('close', code); socket.destroy(); };
      const onData = (chunk) => {
        let frames; try { frames = parse(chunk); } catch { return finish(1009); }
        for (const f of frames) {
          if (f.opcode === 1) ws.emit('message', f.data.toString('utf8'));
          else if (f.opcode === 2) ws.emit('binary', f.data);
          else if (f.opcode === 9) socket.write(encodeFrame(10, f.data, true));
          else if (f.opcode === 8) { if (!closed) socket.write(encodeFrame(8, f.data, true)); finish(f.data.length >= 2 ? f.data.readUInt16BE(0) : 1005); }
        }
      };
      socket.on('data', onData); socket.on('close', () => finish(1006)); socket.on('error', () => finish(1006));
      ws.protocol = res.headers['sec-websocket-protocol'] || '';
      ws.send = (text) => { if (!closed) socket.write(encodeFrame(1, Buffer.from(text), true)); };
      ws.close = (code = 1000) => { if (closed) return; const b = Buffer.alloc(2); b.writeUInt16BE(code); socket.write(encodeFrame(8, b, true)); socket.end(); finish(code); };
      ws.get_closed = () => closed;
      resolve(ws);
      if (head?.length) onData(head);
    });
    req.end();
  });
}

// Server-side accept for a raw 'upgrade' (used by test fixtures).
export function wsAccept(req, socket, { protocol } = {}) {
  const key = req.headers['sec-websocket-key'];
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
  const ws = new EventEmitter(), parse = frameParser();
  socket.on('data', (chunk) => { for (const f of parse(chunk)) { if (f.opcode === 1) ws.emit('message', f.data.toString('utf8')); else if (f.opcode === 2) ws.emit('binary', f.data); else if (f.opcode === 8) { socket.end(encodeFrame(8, f.data)); ws.emit('close'); } } });
  socket.on('close', () => ws.emit('close'));
  ws.send = (text) => socket.write(encodeFrame(1, Buffer.from(text)));
  ws.sendBinary = (data) => socket.write(encodeFrame(2, data));
  ws.close = (code = 1000) => { const b = Buffer.alloc(2); b.writeUInt16BE(code); socket.end(encodeFrame(8, b)); };
  return ws;
}
