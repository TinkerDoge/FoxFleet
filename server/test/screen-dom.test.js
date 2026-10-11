// DOM-level test of the Android bot-screen page (assets/screen.html + real noVNC) in headless Chrome over CDP, against a fake VNC server.
// Covers ensureFit (forced 2px container -> refit + container sized to the window) and the verdict (collapsed / clipped / ok).
// Skipped when no Chrome is installed (set CHROME to point at one). No extra dependencies: Node's global WebSocket + fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const ASSETS = path.join(import.meta.dirname, '..', '..', 'android', 'app', 'src', 'main', 'assets');
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => c && fs.existsSync(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

async function setup(t) {
  const web = http.createServer((req, res) => {
    const f = path.join(ASSETS, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ASSETS) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r)); t.after(() => { web.closeAllConnections?.(); web.close(); });
  const vncPort = await freePort();
  const vnc = spawn(process.execPath, [path.join(import.meta.dirname, 'screen-fakevnc.mjs'), String(vncPort)], { stdio: 'ignore' }); t.after(() => vnc.kill());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-screen-dom-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--window-size=412,915', 'about:blank'], { stdio: 'ignore' }); t.after(() => chrome.kill());
  let port; for (let i = 0; i < 100 && !port; i++) { try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await sleep(100); } }
  assert.ok(port, 'chrome did not start');
  let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.some((x) => x.type === 'page')) break; } catch {} await sleep(100); }
  const ws = new WebSocket(tabs.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r)); t.after(() => ws.close());
  let id = 0; const waits = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } });
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ev=[];window.FoxfleetBridge={onEvent:(t,d)=>window.__ev.push(t+":"+d)}' });
  return { cdp, ev, url: `http://127.0.0.1:${web.address().port}/screen.html`, vncUrl: `ws://127.0.0.1:${vncPort}/?ticket=x` };
}
async function open(h, { collapse }) {
  await h.cdp('Page.navigate', { url: h.url });
  for (let i = 0; i < 50 && !(await h.ev('!!window.hub')); i++) await sleep(100);
  if (collapse) await h.ev(`(()=>{const s=document.createElement('style');s.textContent='#screen{width:2px!important;height:1px!important;min-width:0!important;min-height:0!important}';document.head.appendChild(s)})()`);
  await h.ev(`hub.connect(${JSON.stringify(h.vncUrl)})`);
}
const diag = async (h) => JSON.parse(await h.ev('hub.diagnostics()'));
async function until(h, pred, ms = 12000) { const end = Date.now() + ms; let d; while (Date.now() < end) { d = await diag(h); if (pred(d)) return d; await sleep(250); } return d; }
const size = (css) => css.split('x').map(Number);

test('forced 2px container: ensureFit sizes #screen to the window, canvas fits, verdict is ok, bytes are counted', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const h = await setup(t); await open(h, { collapse: true });
  const d = await until(h, (x) => x.verdict === 'ok' && x.fixes >= 1);
  assert.equal(d.verdict, 'ok', JSON.stringify(d));
  assert.ok(d.fixes >= 1 && d.fixes < 10, 'refit ran, and does not flap: ' + d.fixes);
  assert.match(d.box, /window|container/);
  const [w, hh] = size(d.css); assert.ok(Math.abs(w - 412) <= 3 && Math.abs(hh - 258) <= 3, 'canvas fit to 412x258, got ' + d.css);
  assert.equal(d.visible.replace(/\.\d+/g, ''), d.css, 'whole canvas is visible, not clipped by the sliver container');
  const host = await h.ev(`(()=>{const r=document.getElementById('screen').getBoundingClientRect();return [Math.round(r.width),Math.round(r.height)]})()`);
  assert.deepEqual(host, [412, 915], '#screen follows the window');
  assert.ok(d.bytes > 1000 && d.msgs > 1, 'bytes counted: ' + d.bytes); assert.equal(d.blank, false);
});

test('clipped canvas: size is fine but it is off-screen -> verdict clipped, blank true', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const h = await setup(t); await open(h, { collapse: false });
  const ok = await until(h, (x) => x.verdict === 'ok'); assert.equal(ok.verdict, 'ok', JSON.stringify(ok));
  await h.ev(`(()=>{const c=document.querySelector('#screen canvas');c.style.position='relative';c.style.left='3000px'})()`);
  const d = await until(h, (x) => x.verdict === 'clipped', 8000);
  assert.equal(d.verdict, 'clipped', JSON.stringify(d)); assert.match(d.visible, /^0x/, 'nothing of the canvas is inside the window: ' + d.visible);
  const d2 = await until(h, (x) => x.blank === true, 8000); assert.equal(d2.blank, true);
});

test('hub.disconnect stops the sampler (no verdict updates afterwards)', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const h = await setup(t); await open(h, { collapse: false });
  await until(h, (x) => x.verdict === 'ok'); await h.ev('hub.disconnect()'); await sleep(800); // let the disconnect's own state line land first
  const a = (await diag(h)).log.length; await sleep(3000); const b = (await diag(h)).log.length;
  assert.equal(b, a, 'no log lines (blank/refit) after disconnect');
});
