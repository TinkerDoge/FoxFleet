// A TCP proxy that stands in for "Cloudflare in front of the hub" and misbehaves on command (HTTP and WebSocket both pass through it).
//   mode 'pass'  : forward bytes
//   mode '502'   : answer every new connection with an HTTP 502 and close (a tunnel that is down)
//   mode 'hang'  : accept and say nothing (a black hole / half-open tunnel)
//   resetAll()   : destroy every live connection (SSE and WebSocket die mid-stream)
import net from 'node:net';

export async function faultProxy(t, target) {
  const live = new Set(); let mode = 'pass', frozen = false;
  const server = net.createServer((c) => {
    live.add(c); c.on('close', () => live.delete(c)); c.on('error', () => c.destroy());
    if (mode === '502') { const body = '{"error":"Bad gateway"}'; c.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); return; }
    if (mode === 'hang') return;
    const up = net.connect(target.port, target.host ?? '127.0.0.1'); live.add(up); up.on('close', () => { live.delete(up); c.destroy(); }); up.on('error', () => up.destroy());
    c.on('close', () => up.destroy()); up.on('data', (d) => { if (!frozen) c.write(d); });
    // the hub only answers its own loopback Host: put it back, as a tunnel would put the public name back
    c.on('data', (d) => { if (frozen) return; const x = d.toString('latin1'); up.write(/^host:/im.test(x) ? Buffer.from(x.replace(/^host:.*$/im, `Host: 127.0.0.1:${target.port}`), 'latin1') : d); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const p = { port: server.address().port, base: `http://127.0.0.1:${server.address().port}`,
    set mode(m) { mode = m; if (m !== 'pass') p.resetAll(); }, get mode() { return mode; },
    /** Black hole: keep every connection open but carry nothing (a half-open tunnel). */
    freeze(on = true) { frozen = on; },
    resetAll() { for (const s of [...live]) s.destroy(); },
    /** Down for ms: 502s, and everything already open is cut. */
    async outage(ms) { mode = '502'; p.resetAll(); await new Promise((r) => setTimeout(r, ms)); mode = 'pass'; } };
  t.after(async () => { p.resetAll(); await new Promise((r) => server.close(r)); });
  return p;
}
