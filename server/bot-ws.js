// The bot socket: a strict RFC 6455 server side (text frames only, no extensions) for /api/bot/ws. Zero dependencies.
// It never shares code paths with the connector/screen sockets in ws.js, except the frame encoder and the accept-key function.
import { encodeFrame, acceptKey } from './ws.js';
import { LIMITS, selectSubprotocol } from './bot-protocol.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Pure handshake validation: the HTTP status to refuse with, or null when the upgrade request is acceptable. */
export function checkHandshake(req) {
  const h = req.headers ?? {}, tokens = (v) => String(v ?? '').split(',').map((x) => x.trim().toLowerCase());
  if (req.method !== 'GET' || String(h.upgrade ?? '').toLowerCase() !== 'websocket' || !tokens(h.connection).includes('upgrade')) return 400;
  if (h['sec-websocket-version'] !== '13') return 400;
  const key = h['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) return 400;
  if (!selectSubprotocol(h['sec-websocket-protocol'])) return 400;
  return null;
}

/**
 * Takes over an upgraded socket. Options: heartbeatMs, maxMessageBytes, maxQueue, maxBufferedBytes (all optional) and the callbacks
 * onOpen(conn) (right after the 101, before any received byte is processed), onMessage(text, conn) (async, strictly serialized) and
 * onClose(code, reason) (exactly once).
 */
export function acceptBotSocket(req, socket, head, opts = {}) {
  const { maxMessageBytes = LIMITS.max_frame_bytes, heartbeatMs = 25000, maxQueue = 64, maxBufferedBytes = 8 * 1024 * 1024 } = opts;
  let buf = Buffer.alloc(0), finished = false, fragments = null, fragmentBytes = 0, lastFrame = Date.now(), paused = false, pumping = false;
  const queue = [];
  socket.on('error', () => {});
  const selected = selectSubprotocol(req.headers['sec-websocket-protocol']);
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`, `Sec-WebSocket-Protocol: ${selected}`, '', ''].join('\r\n'));

  const conn = {
    /** Resolves when the underlying socket is gone. */
    done: new Promise((resolve) => socket.once('close', resolve)),
    get paused() { return paused; },
    send(obj) {
      if (finished) return;
      socket.write(encodeFrame(1, Buffer.from(JSON.stringify(obj))));
      if (socket.writableLength > maxBufferedBytes) conn.close(1013, 'reading too slowly');
    },
    close(code = 1000, reason = '') {
      if (finished) return;
      finish(code, reason);
      const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
      socket.write(encodeFrame(8, Buffer.concat([payload, Buffer.from(reason).subarray(0, 123)])));
      socket.end(); socket.resume();
      const drop = setTimeout(() => socket.destroy(), 1000); drop.unref(); socket.once('close', () => clearTimeout(drop));
    },
  };
  const beat = setInterval(() => {
    if (Date.now() - lastFrame > 3 * heartbeatMs) return conn.close(1001, 'idle timeout');
    socket.write(encodeFrame(9, Buffer.alloc(0)));
  }, heartbeatMs); beat.unref();
  function finish(code, reason) { if (finished) return; finished = true; clearInterval(beat); opts.onClose?.(code, reason); }
  async function pump() {
    if (pumping) return; pumping = true;
    try {
      while (queue.length && !finished) {
        try { await opts.onMessage?.(queue.shift(), conn); } catch { conn.close(1011, 'internal error'); }
        if (paused && queue.length <= maxQueue / 2) { paused = false; socket.resume(); parse(); }
      }
    } finally { pumping = false; }
  }
  function parse() {
    while (buf.length >= 2 && !finished) {
      if (queue.length > maxQueue) { paused = true; socket.pause(); break; }
      const fin = buf[0] & 0x80, rsv = buf[0] & 0x70, opcode = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (rsv || !masked || ![0, 1, 2, 8, 9, 10].includes(opcode)) return conn.close(1002, 'protocol error');
      if (opcode >= 8 && (!fin || len > 125)) return conn.close(1002, 'protocol error');
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) break;
        const big = buf.readBigUInt64BE(2); if (big > BigInt(maxMessageBytes)) return conn.close(1009, 'message too big');
        len = Number(big); off = 10;
      }
      if (opcode === 2 && !fragments) return conn.close(1003, 'binary messages are not supported');
      if (opcode < 8 && (len > maxMessageBytes || fragmentBytes + len > maxMessageBytes)) return conn.close(1009, 'message too big');
      const need = off + 4 + len; if (buf.length < need) break;
      const key = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, need));
      for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3];
      buf = buf.subarray(need); lastFrame = Date.now();
      if (opcode === 8) return onPeerClose(data);
      if (opcode === 9) { socket.write(encodeFrame(10, data)); continue; }
      if (opcode === 10) continue;
      if (opcode === 0) { if (!fragments) return conn.close(1002, 'protocol error'); }
      else if (fragments) return conn.close(1002, 'protocol error');
      if (!fin) { fragments ??= []; fragments.push(data); fragmentBytes += len; continue; }
      const message = fragments ? Buffer.concat([...fragments, data]) : data; fragments = null; fragmentBytes = 0;
      let text; try { text = UTF8.decode(message); } catch { return conn.close(1007, 'invalid UTF-8'); }
      queue.push(text); void pump();
    }
  }
  function onPeerClose(data) {
    if (data.length === 1) return conn.close(1002, 'protocol error');
    if (data.length === 0) return conn.close(1000);
    const code = data.readUInt16BE(0);
    if (!(code >= 1000 && code <= 1003 || code >= 1007 && code <= 1011 || code >= 3000 && code <= 4999)) return conn.close(1002, 'protocol error');
    try { UTF8.decode(data.subarray(2)); } catch { return conn.close(1007, 'invalid UTF-8'); }
    conn.close(code);
  }
  const onData = (chunk) => { buf = Buffer.concat([buf, chunk]); parse(); };
  socket.on('data', onData);
  socket.on('end', () => { finish(1006, ''); socket.destroy(); });
  socket.on('close', () => finish(1006, ''));
  opts.onOpen?.(conn);
  if (head?.length) onData(head);
  return conn;
}
