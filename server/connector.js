// Reverse connector: a Hermes agent dials OUT to the hub (WebSocket, per-agent token) and the hub
// tunnels its dashboard/chat-API HTTP calls back over that socket. Nothing on the agent's network
// has to be reachable from outside. Each connected agent gets two loopback-only forwarders; the
// existing Hermes client simply talks to those ports (see hermes.js `tunnelPorts`).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { tunnelPorts } from './hermes.js';

const MAX_STREAMS = 64, CHUNK = 48 * 1024;
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'expect']);

export function connectorHub() {
  const links = new Map(); // connectorId -> link
  function forwarder(link, svc) {
    const server = http.createServer((creq, cres) => {
      if (link.streams.size >= MAX_STREAMS) { cres.writeHead(503); return cres.end(); }
      const id = randomBytes(6).toString('hex'), s = { cres, started: false };
      link.streams.set(id, s);
      const headers = {}; for (const [k, v] of Object.entries(creq.headers)) if (!HOP.has(k)) headers[k] = v;
      link.send({ t: 'req', id, svc, method: creq.method, url: creq.url, headers });
      creq.on('data', (c) => { for (let i = 0; i < c.length; i += CHUNK) link.send({ t: 'body', id, b: c.subarray(i, i + CHUNK).toString('base64') }); });
      creq.on('end', () => link.send({ t: 'body-end', id }));
      const gone = () => { if (link.streams.delete(id)) link.send({ t: 'cancel', id }); };
      cres.on('close', gone); creq.on('error', gone);
    });
    // WebSocket upgrades (screen takeover, gateway socket) are tunnelled as raw byte frames after the handshake.
    server.on('upgrade', (creq, socket, head) => {
      if (link.streams.size >= MAX_STREAMS) return socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
      const id = randomBytes(6).toString('hex'), s = { socket, started: false, ws: true };
      link.streams.set(id, s);
      const headers = {}; for (const [k, v] of Object.entries(creq.headers)) if (k !== 'host') headers[k] = v;
      link.send({ t: 'ws-open', id, svc, url: creq.url, headers });
      socket.on('data', (c) => { for (let i = 0; i < c.length; i += CHUNK) link.send({ t: 'ws-data', id, b: c.subarray(i, i + CHUNK).toString('base64') }); });
      const gone = () => { if (link.streams.delete(id)) link.send({ t: 'ws-close', id }); };
      socket.on('close', gone); socket.on('error', () => socket.destroy());
      if (head?.length) link.send({ t: 'ws-data', id, b: head.toString('base64') });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
  }
  return {
    drop: (id) => links.get(id)?.close(),
    isOnline: (id) => links.has(id),
    lastSeen: (id) => links.get(id)?.seen ?? null,
    async attach(connectorId, ws) {
      links.get(connectorId)?.close(); // a new connection replaces the old one
      const link = { streams: new Map(), seen: Date.now(), servers: [], send: (o) => { try { ws.send(JSON.stringify(o)); } catch {} },
        close() { for (const { server } of this.servers) server.close(); for (const s of this.streams.values()) { try { (s.cres || s.socket).destroy(); } catch {} } this.streams.clear(); if (links.get(connectorId) === this) { links.delete(connectorId); tunnelPorts.delete(connectorId); } try { ws.close(); } catch {} } };
      const dash = await forwarder(link, 'dashboard'), api = await forwarder(link, 'api');
      link.servers = [dash, api]; links.set(connectorId, link); tunnelPorts.set(connectorId, { dashboard: dash.port, api: api.port });
      ws.on('message', (text) => {
        link.seen = Date.now(); let m; try { m = JSON.parse(text); } catch { return; }
        const s = link.streams.get(m.id);
        if (s?.ws) {
          if (m.t === 'ws-up' && !s.started) { s.started = true; const h = m.headers || {}; s.socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', ...(h['sec-websocket-accept'] ? [`Sec-WebSocket-Accept: ${String(h['sec-websocket-accept']).replace(/[\r\n]/g, '')}`] : []), ...(h['sec-websocket-protocol'] ? [`Sec-WebSocket-Protocol: ${String(h['sec-websocket-protocol']).replace(/[\r\n]/g, '')}`] : []), '', ''].join('\r\n')); }
          else if (m.t === 'ws-data' && s.started) s.socket.write(Buffer.from(String(m.b || ''), 'base64'));
          else if (m.t === 'ws-close') { link.streams.delete(m.id); s.socket.destroy(); }
          else if (m.t === 'error') { link.streams.delete(m.id); if (!s.started) s.socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); else s.socket.destroy(); }
          return;
        }
        if (m.t === 'res' && s && !s.started) { s.started = true; const h = {}; for (const [k, v] of Object.entries(m.headers || {})) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'content-length') h[k] = v; try { s.cres.writeHead(Number(m.status) || 502, h); } catch {} }
        else if (m.t === 'data' && s?.started) s.cres.write(Buffer.from(String(m.b || ''), 'base64'));
        else if (m.t === 'end' && s) { link.streams.delete(m.id); s.cres.end(); }
        else if (m.t === 'error' && s) { link.streams.delete(m.id); if (!s.started) { s.cres.writeHead(502); } s.cres.end(); }
      });
      ws.on('close', () => link.close());
      link.send({ t: 'hello', v: 1 });
      const beat = setInterval(() => { if (Date.now() - link.seen > 90_000) return link.close(); link.send({ t: 'ping' }); }, 25_000); beat.unref?.();
      const baseClose = link.close; link.close = function () { clearInterval(beat); return baseClose.call(this); };
      return link;
    },
    closeAll() { for (const l of [...links.values()]) l.close(); },
  };
}
