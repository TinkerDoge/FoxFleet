// Bot Screen relay: drives a Hermes profile's Xfce desktop (TigerVNC) through the dashboard's
// gateway JSON-RPC socket (display.start/observe/lease.*) and splices the phone's noVNC socket
// to the dashboard's /api/display/ws RFB bridge. The phone never sees a dashboard credential:
// it gets a hub ticket (single-use, 30 s, bound to one agent) that maps to the upstream display ticket.
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';
import { base } from './hermes.js';
import { wsConnect } from './ws.js';

export const TICKET_TTL_MS = 30_000;
export const TAKEOVER_MAX_MS = 15 * 60_000;   // auto hand-back after 15 min of control
const RPC_TIMEOUT_MS = 20_000;                 // display.start can block while Xvnc boots

export function screenRelay(upstream, { takeoverMs = TAKEOVER_MAX_MS, ticketTtlMs = TICKET_TTL_MS, connect = wsConnect } = {}) {
  const gateways = new Map(), tickets = new Map(), holds = new Map(), live = new Set();
  const keyOf = (m) => m.name;

  async function gateway(m) {
    const existing = gateways.get(keyOf(m));
    if (existing && !existing.closed && existing.conn === m) return existing;
    if (existing) existing.dispose();
    // Single-use dashboard WS ticket from the authenticated REST session the hub already holds.
    let ticket;
    try {
      const r = await upstream.dashboard(m, '/api/auth/ws-ticket', { method: 'POST' });
      if (r.ok) ticket = (await r.json())?.ticket; else await r.body?.cancel();
    } catch { /* fall through */ }
    const origin = new URL(base(m, 'dashboard')).origin;
    const query = ticket ? `ticket=${encodeURIComponent(ticket)}` : m.dashboardWsToken ? `token=${encodeURIComponent(m.dashboardWsToken)}` : null;
    if (!query) throw fault(502, 'Agent screen unavailable: dashboard refused a gateway ticket');
    let ws;
    try { ws = await connect(origin.replace(/^http/, 'ws') + '/api/ws?' + query, { headers: { Origin: origin }, timeoutMs: 8000 }); }
    catch { throw fault(502, 'Agent screen unavailable: gateway socket refused'); }
    const pending = new Map(); let seq = 0;
    const g = { conn: m, closed: false, viewerId: null,
      call(method, params = {}) {
        return new Promise((resolve, reject) => {
          if (g.closed) return reject(fault(502, 'Agent screen connection closed'));
          const id = `hub-${++seq}`;
          const timer = setTimeout(() => { pending.delete(id); reject(fault(504, 'Agent screen request timed out')); }, RPC_TIMEOUT_MS); timer.unref?.();
          pending.set(id, { resolve, reject, timer });
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { profile: m.profile, ...params } }));
        });
      },
      dispose() { g.closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fault(502, 'Agent screen connection closed')); } pending.clear(); ws.close(); gateways.delete(keyOf(m)); },
    };
    ws.on('message', (text) => {
      let msg; try { msg = JSON.parse(text); } catch { return; }
      const p = msg && pending.get(msg.id); if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(fault(409, String(msg.error.message || 'Screen request refused').slice(0, 200)));
      else p.resolve(msg.result);
    });
    ws.on('close', () => { if (!g.closed) g.dispose(); });
    gateways.set(keyOf(m), g);
    return g;
  }

  const view = (r) => r && ({ running: r.running === true, supported: r.supported !== false, installed: r.installed !== false, geometry: typeof r.geometry === 'string' ? r.geometry : null, blocker: typeof r.blocker === 'string' ? r.blocker : null, lease: r.lease ? { holder: r.lease.holder, epoch: r.lease.epoch, since: r.lease.since } : null });
  function clearHold(name) { const h = holds.get(name); if (h) { clearTimeout(h.timer); holds.delete(name); } }

  return {
    async status(m) { return view(await (await gateway(m)).call('display.status')); },
    async start(m) { return view(await (await gateway(m)).call('display.start')); },
    async observe(m) {
      const g = await gateway(m);
      const r = await g.call('display.observe', g.viewerId ? { viewer_id: g.viewerId } : {});
      if (typeof r?.ticket !== 'string' || typeof r?.viewer_id !== 'string') throw fault(502, 'Invalid screen ticket');
      g.viewerId = r.viewer_id;
      for (const [t, v] of tickets) if (v.expires < Date.now()) tickets.delete(t);
      const ticket = randomBytes(24).toString('base64url');
      tickets.set(ticket, { agent: m.name, conn: m, displayTicket: r.ticket, path: r.path || '/api/display/ws', expires: Date.now() + ticketTtlMs });
      return { ticket, expiresInMs: ticketTtlMs, ...view(r) };
    },
    async takeover(m) {
      const g = await gateway(m);
      if (!g.viewerId) throw fault(409, 'Open the screen before taking over');
      const r = await g.call('display.lease.acquire', { viewer_id: g.viewerId, reason: 'Foxfleet mobile takeover' });
      clearHold(m.name);
      const timer = setTimeout(() => { holds.delete(m.name); g.call('display.lease.release', { viewer_id: g.viewerId }).catch(() => {}); }, takeoverMs); timer.unref?.();
      holds.set(m.name, { timer, until: Date.now() + takeoverMs });
      return { lease: r?.lease ? { holder: r.lease.holder, epoch: r.lease.epoch } : null, autoHandBackAt: Date.now() + takeoverMs };
    },
    async handback(m) {
      clearHold(m.name);
      const g = await gateway(m);
      if (!g.viewerId) return { lease: null };
      const r = await g.call('display.lease.release', { viewer_id: g.viewerId });
      return { lease: r?.lease ? { holder: r.lease.holder, epoch: r.lease.epoch } : null };
    },
    consume(ticket, agentName) {
      const t = typeof ticket === 'string' ? tickets.get(ticket) : undefined;
      if (t) tickets.delete(ticket); // single use, even when it fails below
      if (!t || t.expires < Date.now() || t.agent !== agentName) throw fault(403, 'Screen ticket missing, expired or used');
      return t;
    },
    // Splice the phone's upgraded socket to the dashboard RFB bridge. On close, hand control back.
    proxy(req, socket, head, t) {
      const target = new URL(base(t.conn, 'dashboard')), secure = target.protocol === 'https:';
      const up = (secure ? https : http).request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || (secure ? 443 : 80), method: 'GET',
        path: `${t.path}?display_ticket=${encodeURIComponent(t.displayTicket)}`,
        headers: { Host: target.host, Origin: target.origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': req.headers['sec-websocket-key'], ...(req.headers['sec-websocket-protocol'] ? { 'Sec-WebSocket-Protocol': req.headers['sec-websocket-protocol'] } : {}) } });
      const fail = () => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
      up.on('error', fail);
      up.on('response', (r) => { r.resume(); fail(); });
      up.on('upgrade', (res, upSocket, upHead) => {
        const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${res.headers['sec-websocket-accept']}`];
        if (res.headers['sec-websocket-protocol']) lines.push(`Sec-WebSocket-Protocol: ${res.headers['sec-websocket-protocol']}`);
        socket.write(lines.join('\r\n') + '\r\n\r\n');
        if (upHead?.length) socket.write(upHead);
        if (head?.length) upSocket.write(head);
        socket.setNoDelay(true); upSocket.setNoDelay(true);
        upSocket.pipe(socket); socket.pipe(upSocket); live.add(socket); live.add(upSocket);
        const end = () => { live.delete(socket); live.delete(upSocket); upSocket.destroy(); socket.destroy(); if (holds.has(t.agent)) { const g = gateways.get(t.agent); clearHold(t.agent); g?.call('display.lease.release', { viewer_id: g.viewerId }).catch(() => {}); } };
        upSocket.on('close', end); socket.on('close', end); upSocket.on('error', end); socket.on('error', end);
      });
      up.end();
    },
    clear() { for (const s of live) s.destroy(); live.clear(); for (const g of [...gateways.values()]) g.dispose(); for (const h of holds.values()) clearTimeout(h.timer); holds.clear(); tickets.clear(); },
  };
}
