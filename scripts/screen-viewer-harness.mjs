#!/usr/bin/env node
// Dev tool: runs the Android viewer page (android/app/src/main/assets/screen.html) in headless Chrome with a phone UA/viewport, served on
// https://appassets.androidplatform.net (the WebViewAssetLoader origin) against a hub started by server/test/screen-demo-hub.js, and prints
// the page's own diagnostics + saves a screenshot. Usage: HUB=http://127.0.0.1:PORT OUT=/tmp/x.png node scripts/screen-viewer-harness.mjs [--debug]
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
const ASSETS = path.join(import.meta.dirname, '..', 'android', 'app', 'src', 'main', 'assets');
const HUB = process.env.HUB, OUT = process.env.OUT || '/tmp/viewer.png', DEBUG = process.argv.includes('--debug');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-harness-')); execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/k.pem', '-out', dir + '/c.pem', '-days', '2', '-subj', '/CN=appassets.androidplatform.net'], { stdio: 'ignore' });
const srv = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\/assets\//, ''), f = path.join(ASSETS, p);
  if (!f.startsWith(ASSETS) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}); await new Promise((r) => srv.listen(8443, '127.0.0.1', r));
const chrome = spawn('google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--remote-debugging-port=9333', '--window-size=412,800',
  '--host-resolver-rules=MAP appassets.androidplatform.net:443 127.0.0.1:8443', `--user-data-dir=${dir}/u`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch('http://127.0.0.1:9333/json')).json(); if (tabs.find((t) => t.type === 'page')) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waits = new Map(), console_ = []; ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled') console_.push(d.params.args.map((a) => a.value ?? a.description).join(' ')); else if (d.method === 'Runtime.exceptionThrown') console_.push('EXC ' + d.params.exceptionDetails.text + ' ' + (d.params.exceptionDetails.exception?.description || '')); });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 412, height: 800, deviceScaleFactor: 2.6, mobile: true });
await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 wv' });
// The page's CSP applies exactly as in the app. Native bridge stand-in:
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__ev=[];window.FoxfleetBridge={onEvent:(t,d)=>window.__ev.push([t,d])}' });
await cdp('Page.navigate', { url: 'https://appassets.androidplatform.net/assets/screen.html' });
const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
for (let i = 0; i < 50 && !(await ev('!!window.hub')); i++) await sleep(200);
const post = (p, b) => fetch(HUB + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const obs = await post('/api/agents/bot/screen/observe'); const url = `${HUB.replace(/^http/, 'ws')}/api/agents/bot/screen/ws?ticket=${obs.ticket}`;
if (DEBUG) await ev('hub.setDebug(true)');
await ev(`hub.connect(${JSON.stringify(url)})`);
await sleep(Number(process.env.WAIT_MS) || 9000);
const diag = JSON.parse(await ev('hub.diagnostics()')); const events = await ev('JSON.stringify(window.__ev)');
const shot = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ diag: { ...diag, ua: undefined }, events: JSON.parse(events), console: console_.slice(0, 10) }, null, 1));
chrome.kill(); srv.close(); process.exit(0);
