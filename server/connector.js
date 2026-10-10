// Reverse connector: one process per MACHINE dials OUT to the hub (WebSocket, per-machine token) and the hub
// tunnels each profile's dashboard/chat-API HTTP calls back over that single socket (every frame names its agent). Nothing on the agent's network
// has to be reachable from outside. Each exposed profile gets two loopback-only forwarders; the
// existing Hermes client simply talks to those ports (see hermes.js `tunnelPorts`).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { tunnelPorts } from './hermes.js';

const MAX_STREAMS = 64, CHUNK = 48 * 1024;
const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'expect']);

export function connectorHub() {
  const links = new Map(); // connectorId -> link
  const upListeners = new Set(); // called when a (re)connected machine has announced its native capabilities
  function forwarder(link, agent, svc) {
    const server = http.createServer((creq, cres) => {
      if (link.streams.size >= MAX_STREAMS) { cres.writeHead(503); return cres.end(); }
      const id = randomBytes(6).toString('hex'), s = { cres, started: false };
      link.streams.set(id, s);
      const headers = {}; for (const [k, v] of Object.entries(creq.headers)) if (!HOP.has(k)) headers[k] = v;
      link.send({ t: 'req', id, agent, svc, method: creq.method, url: creq.url, headers });
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
      link.send({ t: 'ws-open', id, agent, svc, url: creq.url, headers });
      socket.on('data', (c) => { for (let i = 0; i < c.length; i += CHUNK) link.send({ t: 'ws-data', id, b: c.subarray(i, i + CHUNK).toString('base64') }); });
      const gone = () => { if (link.streams.delete(id)) link.send({ t: 'ws-close', id }); };
      socket.on('close', gone); socket.on('error', () => socket.destroy());
      if (head?.length) link.send({ t: 'ws-data', id, b: head.toString('base64') });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
  }
  return {
    ui: (id) => links.get(id)?.ui ?? null,
    /** fn(machineId) runs each time a machine (re)connects and announces itself: the hub re-attaches live native sessions then. */
    onUp(fn) { upListeners.add(fn); return () => upListeners.delete(fn); },
    drop: (id) => links.get(id)?.close(),
    isOnline: (id) => links.has(id),
    lastSeen: (id) => links.get(id)?.seen ?? null,
    async attach(connectorId, ws, hooks = {}) {
      links.get(connectorId)?.close(); // a new connection replaces the old one
      const link = { streams: new Map(), seen: Date.now(), servers: [], agents: new Set(), send: (o) => { try { ws.send(JSON.stringify(o)); } catch {} },
        close() { for (const [, p] of this.uiPending ?? []) { clearTimeout(p.timer); p.reject(Object.assign(new Error('The machine disconnected'), { code: 'disconnected' })); } this.uiPending?.clear(); for (const fn of this.uiListeners ?? []) { try { fn('*', { kind: 'link.down' }); } catch {} } for (const { server } of this.servers) server.close(); for (const a of this.agents) tunnelPorts.delete(`${connectorId}:${a}`); this.agents.clear(); for (const s of this.streams.values()) { try { (s.cres || s.socket).destroy(); } catch {} } this.streams.clear(); if (links.get(connectorId) === this) links.delete(connectorId); try { ws.close(); } catch {} } };
      // Profiles the machine exposes: one pair of loopback forwarders each, replaced wholesale on every `profiles` frame.
      link.expose = async (names) => {
        const want = new Set(names);
        for (const a of [...link.agents]) if (!want.has(a)) { link.agents.delete(a); tunnelPorts.delete(`${connectorId}:${a}`); const keep = []; for (const e of link.servers) if (e.agent === a) e.server.close(); else keep.push(e); link.servers = keep; }
        for (const a of want) if (!link.agents.has(a)) {
          const dash = await forwarder(link, a, 'dashboard'), api = await forwarder(link, a, 'api');
          link.servers.push({ ...dash, agent: a }, { ...api, agent: a }); link.agents.add(a); tunnelPorts.set(`${connectorId}:${a}`, { dashboard: dash.port, api: api.port });
        }
      };
      // Native Hermes UI gateway, reached through the connector's allowlist (see connector `ui-call`). One call = one frame out, one frame back.
      link.uiPending = new Map(); link.uiListeners = new Set(); link.uiCaps = {};
      link.ui = {
        caps: (agent) => link.uiCaps[agent] ?? null,
        call(agent, op, params = {}, timeoutMs = 35_000) {
          return new Promise((resolve, reject) => {
            const id = randomBytes(6).toString('hex'), timer = setTimeout(() => { link.uiPending.delete(id); reject(Object.assign(new Error('The machine did not answer in time'), { code: 'timeout' })); }, timeoutMs);
            link.uiPending.set(id, { resolve, reject, timer, agent }); link.send({ t: 'ui-call', id, agent, op, params });
          });
        },
        subscribe(fn) { link.uiListeners.add(fn); return () => link.uiListeners.delete(fn); },
      };
      links.set(connectorId, link);
      ws.on('message', (text) => {
        link.seen = Date.now(); let m; try { m = JSON.parse(text); } catch { return; }
        if (m.t === 'ui-caps') { link.uiCaps = m.caps && typeof m.caps === 'object' ? m.caps : {}; for (const fn of upListeners) { try { fn(connectorId); } catch { /* a listener must not break the tunnel */ } } return; }
        if (m.t === 'ui-ev') { for (const fn of link.uiListeners) { try { fn(m.agent, m.ev); } catch { /* listener bugs must not break the tunnel */ } } return; }
        if (m.t === 'ui-res') { const p = link.uiPending.get(m.id); if (!p) return; link.uiPending.delete(m.id); clearTimeout(p.timer); if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new Error(String(m.error || 'failed').slice(0, 300)), { code: m.code || 'error', ...(m.rpc !== undefined ? { rpc: m.rpc } : {}) })); return; }
        if (m.t === 'profiles') { Promise.resolve(hooks.onProfiles?.(m, link)).then((reply) => reply && link.send({ t: 'registered', ...reply })).catch(() => link.send({ t: 'registered', agents: [], error: 'sync failed' })); return; }
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
      link.send({ t: 'hello', v: 2 });
      const beat = setInterval(() => { if (Date.now() - link.seen > 90_000) return link.close(); link.send({ t: 'ping' }); }, 25_000); beat.unref?.();
      const baseClose = link.close; link.close = function () { clearInterval(beat); return baseClose.call(this); };
      return link;
    },
    closeAll() { for (const l of [...links.values()]) l.close(); },
  };
}
