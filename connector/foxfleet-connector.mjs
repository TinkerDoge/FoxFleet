#!/usr/bin/env node
// Foxfleet connector (Node 22+). Runs on the machine that hosts a Hermes agent and dials OUT to
// your hub, so no inbound port, DNS name or tunnel is needed for the agent.
//
//   HUB_URL=https://your-hub.example  FOXFLEET_TOKEN=<token from the app>  node foxfleet-connector.mjs
//
// Optional: DASHBOARD_URL (default http://127.0.0.1:9119), API_URL (default http://127.0.0.1:8642).
// It only forwards to those two local addresses and never exposes anything else.
import http from 'node:http';

const hub = process.env.HUB_URL || process.argv[2], token = process.env.FOXFLEET_TOKEN || process.argv[3];
const targets = { dashboard: new URL(process.env.DASHBOARD_URL || 'http://127.0.0.1:9119'), api: new URL(process.env.API_URL || 'http://127.0.0.1:8642') };
if (!hub || !token) { console.error('Usage: HUB_URL=https://hub FOXFLEET_TOKEN=… node foxfleet-connector.mjs'); process.exit(2); }
if (typeof WebSocket === 'undefined') { console.error('Node 22 or newer is required (global WebSocket).'); process.exit(2); }
const wsUrl = new URL('/connector', hub); wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
if (wsUrl.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(wsUrl.hostname) && !process.env.ALLOW_INSECURE_HUB) { console.error('Refusing plain ws:// to a non-local hub. Use https, or set ALLOW_INSECURE_HUB=1 on a trusted LAN.'); process.exit(2); }

let delay = 1000;
function connect() {
  const ws = new WebSocket(wsUrl, ['foxfleet.v1', token]);
  const reqs = new Map();
  const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  ws.onopen = () => { delay = 1000; console.log('connected to hub'); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.t === 'req') {
      const target = targets[m.svc]; if (!target) return send({ t: 'error', id: m.id });
      const up = http.request({ hostname: target.hostname, port: target.port || 80, method: m.method, path: m.url, headers: m.headers }, (res) => {
        send({ t: 'res', id: m.id, status: res.statusCode, headers: res.headers });
        res.on('data', (c) => send({ t: 'data', id: m.id, b: c.toString('base64') }));
        res.on('end', () => { send({ t: 'end', id: m.id }); reqs.delete(m.id); });
      });
      up.on('error', () => { send({ t: 'error', id: m.id }); reqs.delete(m.id); });
      reqs.set(m.id, up);
    } else if (m.t === 'ws-open') {
      const target = targets[m.svc]; if (!target) return send({ t: 'error', id: m.id });
      const headers = { ...m.headers, host: target.host, origin: target.origin }; // rewrite to the local service's own identity
      const up = http.request({ hostname: target.hostname, port: target.port || 80, method: 'GET', path: m.url, headers });
      up.on('upgrade', (res, sock, head) => {
        reqs.set(m.id, sock);
        send({ t: 'ws-up', id: m.id, headers: { 'sec-websocket-accept': res.headers['sec-websocket-accept'], 'sec-websocket-protocol': res.headers['sec-websocket-protocol'] } });
        const out = (c) => { for (let i = 0; i < c.length; i += 48 * 1024) send({ t: 'ws-data', id: m.id, b: c.subarray(i, i + 48 * 1024).toString('base64') }); };
        if (head?.length) out(head);
        sock.on('data', out); sock.on('close', () => { if (reqs.delete(m.id)) send({ t: 'ws-close', id: m.id }); }); sock.on('error', () => sock.destroy());
      });
      up.on('response', (res) => { res.resume(); send({ t: 'error', id: m.id }); });
      up.on('error', () => { send({ t: 'error', id: m.id }); reqs.delete(m.id); });
      reqs.set(m.id, up); up.end();
    } else if (m.t === 'ws-data') { const x = reqs.get(m.id); if (x?.write && x.constructor.name !== 'ClientRequest') x.write(Buffer.from(m.b, 'base64')); }
    else if (m.t === 'ws-close') { reqs.get(m.id)?.destroy(); reqs.delete(m.id); }
    else if (m.t === 'ping') send({ t: 'pong' });
    else if (m.t === 'body') reqs.get(m.id)?.write(Buffer.from(m.b, 'base64'));
    else if (m.t === 'body-end') reqs.get(m.id)?.end();
    else if (m.t === 'cancel') { reqs.get(m.id)?.destroy(); reqs.delete(m.id); }
  };
  ws.onclose = () => { for (const r of reqs.values()) r.destroy(); console.log(`disconnected; retrying in ${delay / 1000}s`); setTimeout(connect, delay); delay = Math.min(delay * 2, 60000); };
  ws.onerror = () => {};
}
connect();
