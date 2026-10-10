// Dev/e2e helper (not a test): a hub whose agent "bot" has a Bot Screen. The fake Hermes dashboard speaks the real display.* JSON-RPC and
// bridges /api/display/ws to a REAL VNC server (x11vnc on Xvfb), so a real noVNC page can be exercised through the hub's ticketed relay.
//   VNC_PORT=5977 node server/test/screen-demo-hub.js [webDist]    -> prints "HUB <url>", runs until killed
import net from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes, fakeDashboard } from './fixtures.js';
import { wsAccept } from '../ws.js';
import { createHub } from '../index.js';
const cleanups = [], t = { after: (f) => cleanups.push(f), skip() {} }, vnc = Number(process.env.VNC_PORT || 5977), log = [];
const base = fakeDashboard(log);
const m = await mockHermes(t, { onUpgrade: (req, socket, head) => {
  const u = new URL(req.url, 'http://mock');
  if (u.pathname !== '/api/display/ws') return base(req, socket, head);
  if (u.searchParams.get('display_ticket') !== 'display-ticket-1') { const ws = wsAccept(req, socket); return ws.close(4401); }
  const ws = wsAccept(req, socket), tcp = net.connect(vnc, '127.0.0.1');
  let done = false; const end = () => { if (done) return; done = true; tcp.destroy(); try { ws.close(4001); } catch {} };
  tcp.on('data', (d) => { if (!done) try { ws.sendBinary(d); } catch {} }); tcp.on('close', end); tcp.on('error', end);
  ws.on('binary', (d) => { if (!done) tcp.write(d); }); ws.on('close', () => { done = true; tcp.destroy(); });
} });
const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-screen-demo-'));
await writeFile(path.join(dir, 'config.json'), JSON.stringify({ machines: [{ ...m.connection, name: 'bot', label: 'Bot' }] }));
const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true });
await new Promise((r) => server.listen(Number(process.env.PORT) || 0, '127.0.0.1', r));
console.log('HUB http://127.0.0.1:' + server.address().port);
process.on('SIGTERM', async () => { for (const f of cleanups.reverse()) await f(); process.exit(0); });
setInterval(() => {}, 1 << 30);
