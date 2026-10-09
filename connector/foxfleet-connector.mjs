#!/usr/bin/env node
// Foxfleet connector (Node 22+, no dependencies). ONE process per MACHINE.
//
//   curl -fsSL https://your-hub/c/<pairing-code> | sh        (the hub shows you this exact line)
//   node foxfleet-connector.mjs pair --hub https://your-hub --code ABCDE-FGHJK
//
// It pairs once, finds the Hermes profiles on this computer, lets you choose which to share, then keeps ONE outbound
// WebSocket to your hub for all of them. Nothing listens on this machine and no port has to be opened.
// Dashboard passwords and API keys are read from each profile's own files and used locally; they are never sent to the hub.
//
// Commands: pair | run | profiles | status | doctor | install-service | uninstall-service | unpair | help
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.3.0-alpha';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const log = (...a) => console.log(...a);

// ---------- config (0600, per user, outside any repo) ----------
export function configDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.FOXFLEET_CONFIG_DIR) return env.FOXFLEET_CONFIG_DIR;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'foxfleet');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'foxfleet');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'foxfleet');
}
const configFile = () => path.join(configDir(), 'connector.json');
export function loadConfig() { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return null; } }
export function saveConfig(cfg) {
  const f = configFile(); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, f);
}

// ---------- Hermes discovery (layout verified against hermes-agent: hermes_constants.py / hermes_cli/profiles.py) ----------
// Root: ~/.hermes (Windows: %LOCALAPPDATA%\hermes) or HERMES_HOME (if that points inside <root>/profiles/<id>, the root is two levels up).
// Profiles: "default" = the root itself; named ones are <root>/profiles/<id> where id matches [a-z0-9][a-z0-9_-]{0,63}, the dir has an
// identity marker file, and it is not tombstoned at <root>/profiles/.deleted/<id>.
const MARKERS = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db'];
export function hermesRoot({ env = process.env, platform = process.platform, home = os.homedir(), override } = {}) {
  const explicit = override || env.FOXFLEET_HERMES_HOME || env.HERMES_HOME;
  if (explicit) { const p = path.resolve(explicit.replace(/^~(?=$|[\\/])/, home)); return path.basename(path.dirname(p)) === 'profiles' ? path.dirname(path.dirname(p)) : p; }
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'hermes');
  return path.join(home, '.hermes');
}
const hasMarker = (dir) => MARKERS.some((m) => { try { fs.lstatSync(path.join(dir, m)); return true; } catch { return false; } });
export function discoverProfiles(root) {
  const out = [];
  if (hasMarker(root)) out.push({ profile: 'default', home: root });
  const pdir = path.join(root, 'profiles');
  let names = []; try { names = fs.readdirSync(pdir, { withFileTypes: true }).filter((e) => e.isDirectory() && PROFILE_ID.test(e.name)).map((e) => e.name).sort(); } catch { /* none */ }
  for (const n of names) {
    const home = path.join(pdir, n);
    if (hasMarker(home) && !fs.existsSync(path.join(pdir, '.deleted', n))) out.push({ profile: n, home });
  }
  return out;
}
export function parseEnv(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
// Tiny reader for the nested scalar keys we need from config.yaml: returns { "a.b.c": "value" }. Not a YAML parser.
export function yamlScalars(text) {
  const out = {}, stack = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = /^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(raw); if (!m) continue;
    const indent = m[1].length; while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    let v = m[3].replace(/\s+#.*$/, '').trim();
    if (v === '') { stack.push({ indent, key: m[2] }); continue; }
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[[...stack.map((s) => s.key), m[2]].join('.')] = v;
  }
  return out;
}
const pick = (map, ...suffixes) => { for (const s of suffixes) for (const [k, v] of Object.entries(map)) if (v !== '' && (k === s || k.endsWith('.' + s))) return v; return undefined; };
const toPort = (v, fb) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : fb; };
const localHost = (h) => { if (!h || h === '0.0.0.0' || h === '::') return '127.0.0.1'; return LOOPBACK.has(h) ? h : null; };
// What this machine knows about one profile, read locally. Secrets stay in this object and are only ever used for localhost requests.
export function profileTargets(p, { cfg = {}, env = process.env, defaultDashboardPort = 9119 } = {}) {
  let e = {}, y = {};
  try { e = parseEnv(fs.readFileSync(path.join(p.home, '.env'), 'utf8')); } catch { /* optional */ }
  try { y = yamlScalars(fs.readFileSync(path.join(p.home, 'config.yaml'), 'utf8')); } catch { /* optional */ }
  const over = cfg.profiles?.[p.profile] ?? {};
  const upper = p.profile.toUpperCase().replace(/-/g, '_');
  const apiHost = localHost(e.API_SERVER_HOST ?? pick(y, 'api_server.host', 'api_server.extra.host')) ?? '127.0.0.1';
  const apiPort = toPort(over.apiPort ?? e.API_SERVER_PORT ?? pick(y, 'api_server.port', 'api_server.extra.port'), 8642);
  const dashPort = toPort(over.dashboardPort ?? cfg.dashboardPort ?? env.FOXFLEET_DASHBOARD_PORT, defaultDashboardPort);
  return {
    profile: p.profile, home: p.home,
    api: { url: new URL(`http://${apiHost.includes(':') ? `[${apiHost.replace(/[\[\]]/g, '')}]` : apiHost}:${apiPort}`), key: over.apiKey ?? e.API_SERVER_KEY ?? pick(y, 'api_server.key', 'api_server.extra.key') },
    dashboard: { url: new URL(`http://127.0.0.1:${dashPort}`),
      user: over.dashboardUser ?? env[`FOXFLEET_DASHBOARD_USER_${upper}`] ?? e.HERMES_DASHBOARD_BASIC_AUTH_USERNAME ?? pick(y, 'basic_auth.username'),
      pass: over.dashboardPassword ?? env[`FOXFLEET_DASHBOARD_PASSWORD_${upper}`] ?? e.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD ?? pick(y, 'basic_auth.password'),
      hashedOnly: Boolean(!(e.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD || pick(y, 'basic_auth.password')) && (e.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH || pick(y, 'basic_auth.password_hash'))) },
  };
}
export function chosen(discovered, cfg) {
  if (cfg.expose === 'all') return discovered.map((d) => d.profile);
  const want = new Set(cfg.profiles ? Object.entries(cfg.profiles).filter(([, v]) => v.expose).map(([k]) => k) : []);
  return discovered.filter((d) => want.has(d.profile)).map((d) => d.profile);
}

// ---------- terminal checklist ----------
export async function checklist(items, initial, io = { input: process.stdin, output: process.stdout }) {
  const on = new Set(initial); const rl = readline.createInterface(io);
  const ask = (q) => new Promise((r) => rl.question(q, r));
  try {
    for (;;) {
      io.output.write('\nHermes profiles found on this computer:\n');
      items.forEach((n, i) => io.output.write(`  ${i + 1}. [${on.has(n) ? 'x' : ' '}] ${n}\n`));
      const a = (await ask("Numbers toggle (e.g. 1 3), a = all, n = none, Enter = continue: ")).trim().toLowerCase();
      if (a === '') return items.filter((n) => on.has(n));
      if (a === 'a') items.forEach((n) => on.add(n)); else if (a === 'n') on.clear();
      else for (const t of a.split(/[\s,]+/)) { const n = items[Number(t) - 1]; if (n) (on.has(n) ? on.delete(n) : on.add(n)); }
    }
  } finally { rl.close(); }
}
async function confirm(q, def = true) {
  if (!process.stdin.isTTY) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((r) => rl.question(`${q} ${def ? '[Y/n]' : '[y/N]'} `, r)); rl.close();
  return a.trim() === '' ? def : /^y/i.test(a);
}

// ---------- background service ----------
export function serviceSpec(platform = process.platform, { node = process.execPath, script = path.resolve(process.argv[1] || ''), home = os.homedir() } = {}) {
  if (platform === 'linux') return { kind: 'systemd', file: path.join(home, '.config', 'systemd', 'user', 'foxfleet-connector.service'), text: `[Unit]\nDescription=Foxfleet connector (one per machine)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${node} ${script} run\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n` };
  if (platform === 'darwin') return { kind: 'launchd', file: path.join(home, 'Library', 'LaunchAgents', 'dev.foxfleet.connector.plist'), text: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>dev.foxfleet.connector</string>\n<key>ProgramArguments</key><array><string>${node}</string><string>${script}</string><string>run</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n` };
  if (platform === 'win32') return { kind: 'schtasks', task: 'FoxfleetConnector', command: `"${node}" "${script}" run` };
  return null;
}
export function installService(platform = process.platform) {
  const spec = serviceSpec(platform); if (!spec) { log('Automatic service install is not supported on this system. Run `node foxfleet-connector.mjs run` under your own supervisor.'); return false; }
  const sh = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
  if (spec.kind === 'systemd') {
    fs.mkdirSync(path.dirname(spec.file), { recursive: true }); fs.writeFileSync(spec.file, spec.text);
    const ok = sh('systemctl', ['--user', 'daemon-reload']) && sh('systemctl', ['--user', 'enable', '--now', 'foxfleet-connector.service']);
    log(ok ? 'Installed: systemd --user service foxfleet-connector (starts at login). To start at boot without logging in: sudo loginctl enable-linger $USER' : `Wrote ${spec.file}, but systemctl --user failed; start it with: systemctl --user enable --now foxfleet-connector`);
    return ok;
  }
  if (spec.kind === 'launchd') {
    fs.mkdirSync(path.dirname(spec.file), { recursive: true }); fs.writeFileSync(spec.file, spec.text);
    const ok = sh('launchctl', ['bootstrap', `gui/${process.getuid()}`, spec.file]); log(ok ? 'Installed: launchd agent dev.foxfleet.connector (starts at login).' : `Wrote ${spec.file}; load it with: launchctl bootstrap gui/$(id -u) ${spec.file}`); return ok;
  }
  const ok = sh('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', spec.task, '/TR', spec.command]);
  log(ok ? `Installed: scheduled task ${spec.task} (starts at logon; run it now with: schtasks /Run /TN ${spec.task}). For a true Windows service use NSSM: nssm install FoxfleetConnector "${process.execPath}" "${path.resolve(process.argv[1] || '')}" run` : 'Could not create the scheduled task. Use NSSM: nssm install FoxfleetConnector <node.exe> <foxfleet-connector.mjs> run');
  return ok;
}
export function uninstallService(platform = process.platform) {
  const spec = serviceSpec(platform); if (!spec) return;
  const sh = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  if (spec.kind === 'systemd') { sh('systemctl', ['--user', 'disable', '--now', 'foxfleet-connector.service']); fs.rmSync(spec.file, { force: true }); sh('systemctl', ['--user', 'daemon-reload']); }
  else if (spec.kind === 'launchd') { sh('launchctl', ['bootout', `gui/${process.getuid()}/dev.foxfleet.connector`]); fs.rmSync(spec.file, { force: true }); }
  else sh('schtasks', ['/Delete', '/F', '/TN', spec.task]);
  log('Background service removed.');
}

// ---------- hub client ----------
export const hubWsUrl = (hub) => { const u = new URL('/connector', hub); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'; return u; };
function checkHub(hub) {
  let u; try { u = new URL(hub); } catch { throw new Error('The hub address is not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('The hub address must start with https://');
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname) && !process.env.FOXFLEET_ALLOW_INSECURE_HUB) throw new Error('Refusing plain http:// to a non-local hub. Use https, or set FOXFLEET_ALLOW_INSECURE_HUB=1 on a trusted network.');
  return u.origin;
}
async function redeem(hub, code, name) {
  let res; try { res = await fetch(new URL('/api/machines/redeem', hub), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name, os: process.platform }) }); }
  catch { throw new Error('Could not reach the hub. Check the address and your internet connection.'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 429 ? 'Too many wrong codes. Wait a few minutes.' : res.status === 403 ? 'That pairing code is wrong, already used or expired. Create a new one in the app (Manage > Machines > Connect a machine).' : body.error || `The hub answered ${res.status}`);
  return body;
}

function runLink(cfg, onState = () => {}) {
  const hub = checkHub(cfg.hub), wsUrl = hubWsUrl(hub), root = hermesRoot({ override: cfg.hermesHome });
  let delay = 1000, ws, stopped = false, everOpened = false, refusals = 0, timer, agents = new Map(), lastSent = '';
  const reqs = new Map();
  const cookies = new Map(); // agent -> dashboard session cookie (kept in memory only)
  const gateways = new Map(); // profile -> HermesGateway (native UI protocol, started lazily)
  function gatewayFor(name) {
    let g = gateways.get(name); if (g) return g;
    const t = agents.get(name); const gw = t && gatewayCommand(root, loadConfig() ?? cfg); if (!gw) return null;
    g = new HermesGateway({ profile: name, home: t.home, launch: defaultLaunch(gw), emit: (ev) => send({ t: 'ui-ev', agent: name, ev }), log });
    gateways.set(name, g); return g;
  }
  // Capability probe: cheap (no process is started); the hub prefers native UI > HTTP runs > chat completions.
  const uiCaps = () => Object.fromEntries([...agents.keys()].map((n) => [n, { native: Boolean(gatewayCommand(root, loadConfig() ?? cfg)), protocol: 'tui-gateway-jsonrpc', ops: Object.keys(UI_OPS).concat(['attach', 'respond', 'info']) }]));
  function scan() {
    const found = discoverProfiles(root), cur = loadConfig() ?? cfg, names = chosen(found, cur);
    const next = new Map(); for (const p of found) if (names.includes(p.profile)) next.set(p.profile, profileTargets(p, { cfg: cur }));
    const fresh = found.map((p) => p.profile).filter((n) => cur.expose !== 'all' && !(cur.profiles && n in cur.profiles));
    if (fresh.length) log(`New profile(s) found but not shared: ${fresh.join(', ')}. Share them with: node ${path.basename(process.argv[1])} profiles`);
    for (const [n, t] of next) if (t.dashboard.hashedOnly && !t.dashboard.pass) log(`Profile ${n}: the dashboard password is stored hashed, so sign-in cannot be automated. Set FOXFLEET_DASHBOARD_PASSWORD_${n.toUpperCase().replace(/-/g, '_')} (or dashboardPassword in connector.json).`);
    agents = next; return [...next.keys()];
  }
  const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };
  function announce(force = false) {
    const names = scan(), key = names.join(',');
    if (!force && key === lastSent) return; lastSent = key;
    send({ t: 'profiles', os: process.platform, profiles: names.map((profile) => ({ profile })) }); send({ t: 'ui-caps', caps: uiCaps() });
  }
  async function dashCookie(t, name) {
    if (cookies.has(name)) return cookies.get(name);
    if (!t.dashboard.user || !t.dashboard.pass) return '';
    try {
      const res = await fetch(new URL('/auth/password-login', t.dashboard.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'basic', username: t.dashboard.user, password: t.dashboard.pass }), redirect: 'manual' });
      await res.arrayBuffer().catch(() => {});
      const c = (res.headers.getSetCookie?.() ?? []).map((x) => x.split(';')[0]).join('; '); if (res.ok) { cookies.set(name, c); return c; }
    } catch { /* dashboard down: the request below will fail the same way */ }
    return '';
  }
  async function handle(m) {
    if (m.t === 'ui-call') { // hub -> connector: one allowlisted action for one shared profile
      const g = gatewayFor(m.agent); if (!g) return send({ t: 'ui-res', id: m.id, ok: false, error: 'This profile has no native Hermes gateway on this machine', code: 'unavailable' });
      try { send({ t: 'ui-res', id: m.id, ok: true, result: await g.call(m.op, m.params ?? {}) }); }
      catch (e) { send({ t: 'ui-res', id: m.id, ok: false, error: String(e.message || e).slice(0, 300), code: e.code || 'error', ...(e.rpc !== undefined ? { rpc: e.rpc } : {}) }); }
      return;
    }
    if (m.t === 'req' || m.t === 'ws-open') {
      const t = agents.get(m.agent), svc = t?.[m.svc];
      if (!svc) return send({ t: 'error', id: m.id });
      const entry = { chunks: [], ended: false, cancelled: false, up: null }; reqs.set(m.id, entry);
      const headers = { ...m.headers }; delete headers.authorization; delete headers.cookie;
      if (m.svc === 'api' && svc.key) headers.authorization = `Bearer ${svc.key}`;
      if (m.svc === 'dashboard') { const c = await dashCookie(t, m.agent); if (c) headers.cookie = c; }
      if (entry.cancelled) return;
      const target = svc.url;
      if (m.t === 'req') {
        const up = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, method: m.method, path: m.url, headers }, (res) => {
          if (res.statusCode === 401 && m.svc === 'dashboard') cookies.delete(m.agent); // next request signs in again
          send({ t: 'res', id: m.id, status: res.statusCode, headers: res.headers });
          res.on('data', (c) => send({ t: 'data', id: m.id, b: c.toString('base64') }));
          res.on('end', () => { send({ t: 'end', id: m.id }); reqs.delete(m.id); });
        });
        up.on('error', () => { send({ t: 'error', id: m.id }); reqs.delete(m.id); });
        entry.up = up; for (const c of entry.chunks) up.write(c); entry.chunks = []; if (entry.ended) up.end();
      } else {
        const h = { ...headers, host: target.host, origin: target.origin }; // present the local service's own identity
        const up = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, method: 'GET', path: m.url, headers: h });
        up.on('upgrade', (res, sock, head) => {
          entry.sock = sock;
          send({ t: 'ws-up', id: m.id, headers: { 'sec-websocket-accept': res.headers['sec-websocket-accept'], 'sec-websocket-protocol': res.headers['sec-websocket-protocol'] } });
          const out = (c) => { for (let i = 0; i < c.length; i += 48 * 1024) send({ t: 'ws-data', id: m.id, b: c.subarray(i, i + 48 * 1024).toString('base64') }); };
          if (head?.length) out(head);
          sock.on('data', out); sock.on('close', () => { if (reqs.delete(m.id)) send({ t: 'ws-close', id: m.id }); }); sock.on('error', () => sock.destroy());
        });
        up.on('response', (res) => { res.resume(); send({ t: 'error', id: m.id }); reqs.delete(m.id); });
        up.on('error', () => { send({ t: 'error', id: m.id }); reqs.delete(m.id); });
        entry.up = up; up.end();
      }
      return;
    }
    const e = reqs.get(m.id);
    if (m.t === 'body' && e) { const b = Buffer.from(m.b, 'base64'); if (e.up) e.up.write(b); else e.chunks.push(b); }
    else if (m.t === 'body-end' && e) { e.ended = true; e.up?.end(); }
    else if (m.t === 'ws-data' && e?.sock) e.sock.write(Buffer.from(m.b, 'base64'));
    else if (m.t === 'ws-close' && e) { e.cancelled = true; (e.sock ?? e.up)?.destroy(); reqs.delete(m.id); }
    else if (m.t === 'cancel' && e) { e.cancelled = true; e.up?.destroy(); reqs.delete(m.id); }
  }
  function connect() {
    if (stopped) return;
    ws = new WebSocket(wsUrl, ['foxfleet.v1', cfg.token]);
    ws.onopen = () => { delay = 1000; everOpened = true; refusals = 0; onState('connected'); log('Connected to the hub.'); lastSent = ''; announce(true); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === 'ping') return send({ t: 'pong' });
      if (m.t === 'registered') { onState('registered', m); if (m.agents?.length) log(`Sharing ${m.agents.length} profile(s): ${m.agents.map((a) => (a.agent === a.profile ? a.profile : `${a.profile} (as ${a.agent})`)).join(', ')}`); else log('Connected; no profiles are shared yet. Run: node foxfleet-connector.mjs profiles'); return; }
      handle(m).catch(() => send({ t: 'error', id: m.id }));
    };
    ws.onclose = () => {
      for (const e of reqs.values()) { e.cancelled = true; try { (e.sock ?? e.up)?.destroy(); } catch {} } reqs.clear();
      if (stopped) return;
      if (!everOpened && ++refusals >= 3) log('The hub keeps refusing this machine (it may have been removed or its token rotated). Create a new pairing code in the app and run: node foxfleet-connector.mjs pair --hub <hub> --code <code>');
      else log(`Disconnected; retrying in ${delay / 1000}s`);
      everOpened = false; setTimeout(connect, delay); delay = Math.min(delay * 2, 60000);
    };
    ws.onerror = () => {};
  }
  connect(); timer = setInterval(() => announce(false), Math.max(30, Number(cfg.rescanSeconds) || 300) * 1000); timer.unref?.();
  return { stop() { stopped = true; clearInterval(timer); for (const g of gateways.values()) g.stop(); try { ws.close(); } catch {} } };
}


// ---------- Hermes UI gateway bridge (native sessions, see design/notes/hermes-ui-gateway.md) ----------
// One long-lived `python -m tui_gateway.entry` per shared profile (newline-delimited JSON-RPC on stdio), owned by this connector so
// there is exactly ONE runtime owner per session. The hub reaches it only through the allowlist below; the gateway never sees a
// browser, credentials stay in the profile's own HERMES_HOME on this machine, and no arbitrary RPC (cli.exec, config.set, ...) is relayed.
const MAX_TEXT = 100_000;
const SERVER_REQUESTS = new Set(['approval', 'clarify']); // the only kinds this bridge answers; others get -32601 so the agent fails fast
// command.dispatch only runs quick/plugin/bundle/skill commands and a few built-ins (compress, retry, undo, memory, skills, queue, steer, goal ...).
// /model and /busy are NOT dispatched: they are config.set (ops `setmodel`, `busy`).
const DISPATCH_OK = new Set(['compress', 'retry', 'undo', 'memory', 'skills']);
const str = (v, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const need = (v, what) => { if (v === null) throw Object.assign(new Error(`${what} is required`), { code: 'bad_params' }); return v; };
// op -> (params) => [gateway method, params]. Anything not listed is refused.
export const UI_OPS = {
  create: (p) => ['session.create', { cols: 100, ...(str(p.title, 300) ? { title: p.title } : {}), ...(str(p.idempotency_key, 80) ? { idempotency_key: p.idempotency_key } : {}) }],
  sessions: () => ['session.list', {}],
  'events.since': (p) => ['session.events.since', { session_id: need(str(p.session_id), 'session_id'), last_seen: Number.isInteger(p.last_seen) ? p.last_seen : 0 }],
  submit: (p) => { if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > MAX_TEXT) throw Object.assign(new Error('text is required'), { code: 'bad_params' }); return ['prompt.submit', { session_id: need(str(p.session_id), 'session_id'), text: p.text, ...(p.queued === true ? { queued: true } : {}) }]; },
  steer: (p) => ['session.steer', { session_id: need(str(p.session_id), 'session_id'), text: need(str(p.text, MAX_TEXT), 'text') }],
  redirect: (p) => ['session.redirect', { session_id: need(str(p.session_id), 'session_id'), text: need(str(p.text, MAX_TEXT), 'text') }],
  interrupt: (p) => ['session.interrupt', { session_id: need(str(p.session_id), 'session_id') }],
  catalog: () => ['commands.catalog', {}],
  resolve: (p) => ['command.resolve', { name: need(str(p.name, 100), 'name') }],
  dispatch: (p) => { const name = need(str(p.name, 100), 'name').replace(/^\//, ''); if (!DISPATCH_OK.has(name)) throw Object.assign(new Error(`/${name} is not available remotely`), { code: 'not_allowed' }); return ['command.dispatch', { name, arg: typeof p.arg === 'string' ? p.arg.slice(0, 2000) : '', session_id: need(str(p.session_id), 'session_id') }]; },
  // /model: session-scoped switch. `--global` / `--once` flags are refused here; a profile default is changed in Hermes itself.
  setmodel: (p) => { const v = need(str(p.value, 300), 'value'); if (/(^|\s)--(global|once)\b/.test(v)) throw Object.assign(new Error('Changing the profile default is not available remotely'), { code: 'not_allowed' }); return ['config.set', { key: 'model', value: v, session_id: need(str(p.session_id), 'session_id') }]; },
  // /busy: the mode is a PROFILE-wide Hermes setting (display.busy_input_mode), not per conversation. `status` only reads it.
  busy: (p) => { const m = need(str(p.mode, 20), 'mode'); if (!['queue', 'steer', 'interrupt', 'status'].includes(m)) throw Object.assign(new Error('mode must be queue, steer, interrupt or status'), { code: 'bad_params' }); return ['config.set', { key: 'busy', value: m }]; },
  models: (p) => ['model.options', { ...(str(p.session_id) ? { session_id: p.session_id } : {}), refresh: p.refresh === true }],
  lock: (p) => ['clarify.lock', { request_id: need(str(p.request_id), 'request_id'), question_id: need(str(p.question_id), 'question_id'), answer: typeof p.answer === 'string' ? p.answer.slice(0, 4000) : '' }],
};

// Which command starts the gateway for a profile. Tried in order; the first hit wins and says where it came from:
//  1. config `uiGatewayCommand` (array)            2. env FOXFLEET_HERMES_GATEWAY_CMD (JSON array)
//  3. config `hermesAgentDir` / env HERMES_AGENT_DIR (a Hermes checkout with a venv)
//  4. a checkout next to the Hermes root (`<root>/hermes-agent`, `~/hermes-agent`, `~/.hermes/hermes-agent`)
//  5. the interpreter named in the first line of the `hermes` command on PATH (or HERMES_BIN), which is the one Hermes is installed in.
// `uiGateway: "off"` turns it off. Returns { cmd, args, cwd, via } or null; `why` (optional array) collects what was tried.
export function gatewayCommand(root, cfg = {}, env = process.env, why = [], platform = process.platform) {
  if (cfg.uiGateway === 'off') { why.push('disabled in the connector config (uiGateway: "off")'); return null; }
  let cmd = cfg.uiGatewayCommand, via = 'uiGatewayCommand in the connector config';
  if (!cmd && env.FOXFLEET_HERMES_GATEWAY_CMD) { try { cmd = JSON.parse(env.FOXFLEET_HERMES_GATEWAY_CMD); via = 'FOXFLEET_HERMES_GATEWAY_CMD'; } catch { why.push('FOXFLEET_HERMES_GATEWAY_CMD is not valid JSON'); } }
  if (cmd !== undefined) { if (Array.isArray(cmd) && cmd.length && cmd.every((x) => typeof x === 'string')) return { cmd: cmd[0], args: cmd.slice(1), cwd: cfg.uiGatewayCwd || undefined, via }; why.push(`${via} must be an array of strings`); }
  const home = os.homedir(), dirs = [cfg.hermesAgentDir, env.HERMES_AGENT_DIR, path.join(root, 'hermes-agent'), path.join(path.dirname(root), 'hermes-agent'), path.join(home, 'hermes-agent'), path.join(home, '.hermes', 'hermes-agent')].filter(Boolean);
  const pys = platform === 'win32' ? [['venv', 'Scripts', 'python.exe'], ['.venv', 'Scripts', 'python.exe']] : [['venv', 'bin', 'python'], ['.venv', 'bin', 'python'], ['venv', 'bin', 'python3'], ['.venv', 'bin', 'python3']];
  for (const dir of [...new Set(dirs)]) {
    if (!fs.existsSync(path.join(dir, 'tui_gateway', 'entry.py'))) continue;
    for (const py of pys) { const f = path.join(dir, ...py); if (fs.existsSync(f)) return { cmd: f, args: ['-m', 'tui_gateway.entry'], cwd: dir, via: `Hermes checkout ${dir}` }; }
    why.push(`${dir} has tui_gateway but no venv/.venv Python`);
  }
  // the `hermes` launcher's own interpreter (a pip/uv install has no checkout to find)
  const bins = []; if (env.HERMES_BIN) bins.push(env.HERMES_BIN); for (const d of String(env.PATH || '').split(path.delimiter)) if (d) bins.push(path.join(d, platform === 'win32' ? 'hermes.exe' : 'hermes'));
  for (const bin of bins) {
    let first = ''; try { if (!fs.statSync(bin).isFile()) continue; const fd = fs.openSync(bin, 'r'); const buf = Buffer.alloc(300); fs.readSync(fd, buf, 0, 300, 0); fs.closeSync(fd); first = buf.toString('utf8').split('\n')[0]; } catch { continue; }
    const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(first); let py = m ? (path.basename(m[1]) === 'env' ? null : m[1]) : null;
    if (py && fs.existsSync(py)) return { cmd: py, args: ['-m', 'tui_gateway.entry'], cwd: undefined, via: `the interpreter of ${bin}` };
    why.push(`${bin} found but its interpreter could not be read`);
  }
  why.push('no Hermes checkout or launcher found');
  return null;
}
// What `doctor` reports: one line per check with a fix. `probe` (default: really start the gateway) is injectable for tests.
export async function nativeDoctor(cfg, { env = process.env, root = hermesRoot({ override: cfg.hermesHome }), probe = defaultProbe } = {}) {
  const out = [], add = (id, status, message, fix) => out.push({ id, status, message, ...(fix ? { fix } : {}) });
  const found = discoverProfiles(root); found.length ? add('profiles', 'ok', `${found.length} Hermes profile(s): ${found.map((p) => p.profile).join(', ')}`) : add('profiles', 'fail', `no Hermes profiles under ${root}`, 'Install Hermes, or point the connector at it with --hermes-home DIR');
  const why = [], gw = gatewayCommand(root, cfg, env, why);
  if (!gw) { add('gateway', 'warn', `no native Hermes gateway: ${why.join('; ')}`, 'Optional: native sessions need the Hermes checkout. Set uiGatewayCommand in the connector config, e.g. ["/path/to/hermes-agent/venv/bin/python","-m","tui_gateway.entry"], or export HERMES_AGENT_DIR=/path/to/hermes-agent. Chats keep working over HTTP without it.'); return out; }
  add('gateway', 'ok', `gateway command: ${[gw.cmd, ...gw.args].join(' ')} (found via ${gw.via})`);
  const r = await probe(gw, found[0]?.home ?? root);
  if (r.ok) add('gateway-start', 'ok', `the gateway starts and reports ready in ${r.ms} ms`); else add('gateway-start', 'fail', `the gateway did not start: ${r.error}`, /ModuleNotFound|No module named/.test(r.error) ? 'The interpreter is missing Hermes dependencies. Use the Python that Hermes itself runs in (Hermes needs Python 3.14 for its pinned dependencies at the time of writing).' : 'Run the command above by hand in a terminal to see the error. It should print a line containing "gateway.ready".');
  return out;
}
async function defaultProbe(gw, home) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false, buf = ''; const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(r); };
    const child = spawn(gw.cmd, gw.args, { cwd: gw.cwd, env: { ...process.env, HERMES_HOME: home, PYTHONUNBUFFERED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }); let err = '';
    const timer = setTimeout(() => finish({ ok: false, error: `no gateway.ready within 60 s. ${err.trim().split('\n').slice(-2).join(' ')}` }), 60_000);
    child.stdout.on('data', (c) => { buf += c; if (buf.includes('gateway.ready')) finish({ ok: true, ms: Date.now() - t0 }); });
    child.stderr.on('data', (c) => { err = (err + c).slice(-1500); });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('exit', (code) => finish({ ok: false, error: `exited with code ${code}. ${err.trim().split('\n').slice(-2).join(' ')}` }));
  });
}

export class HermesGateway {
  constructor({ profile, home, launch, emit, log: lg = () => {}, readyMs = 60_000, callMs = 30_000 }) {
    Object.assign(this, { profile, home, launch, emit, lg, readyMs, callMs }); this.state = 'stopped'; this.pending = new Map(); this.open = new Map(); this.runtime = new Map();
    this.nid = 0; this.failures = 0; this.epoch = null; this.readyP = null; this.child = null;
  }
  // Start (or reuse) the gateway; resolves once `gateway.ready` arrived and client.capabilities was advertised.
  ensure() {
    if (this.state === 'ready') return Promise.resolve();
    if (this.readyP) return this.readyP;
    const wait = this.failures ? Math.min(30_000, 1000 * 2 ** (this.failures - 1)) : 0;
    this.readyP = new Promise((resolve, reject) => {
      const go = () => {
        this.state = 'starting'; let done = false, buf = '';
        const fail = (e) => { if (done) return; done = true; this.failures++; this.readyP = null; this.state = 'down'; try { this.child?.kill(); } catch {} reject(e); };
        const timer = setTimeout(() => fail(new Error('The Hermes gateway did not become ready')), this.readyMs);
        let child; try { child = this.launch(this.profile, this.home); } catch (e) { clearTimeout(timer); return fail(e); }
        this.child = child; child.stderr?.on('data', (c) => { this.stderrTail = (this.stderrTail + c.toString()).slice(-2000); });
        this.stderrTail = '';
        child.stdout.on('data', (c) => {
          buf += c.toString('utf8'); let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
            let f; try { f = JSON.parse(line); } catch { continue; }
            if (f?.method === 'event' && f.params?.type === 'gateway.ready' && !done) {
              done = true; clearTimeout(timer); this.state = 'ready'; this.epoch = f.params.payload?.replay_epoch ?? null; this.readyP = null;
              this.rpc('client.capabilities', { server_requests: true }).catch(() => {}); setTimeout(() => { if (this.state === 'ready') this.failures = 0; }, 60_000).unref?.();
              this.emit({ kind: 'gateway.ready', epoch: this.epoch }); resolve(); continue;
            }
            this.frame(f);
          }
        });
        child.on('error', (e) => { clearTimeout(timer); fail(e); });
        child.on('exit', (code) => { clearTimeout(timer); this.exited(code, fail); });
      };
      if (wait) setTimeout(go, wait); else go();
    });
    return this.readyP;
  }
  exited(code, fail) {
    const was = this.state; this.state = 'down'; this.child = null; this.runtime.clear();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('The Hermes gateway stopped'), { code: 'gateway_down' })); } this.pending.clear();
    const open = [...this.open.keys()]; this.open.clear();
    if (was === 'starting') return fail?.(new Error(`The Hermes gateway exited while starting (code ${code}). ${this.stderrTail.trim().split('\n').slice(-2).join(' ')}`));
    this.failures++; this.readyP = null; this.emit({ kind: 'gateway.down', code, open_requests: open });
  }
  write(o) { if (!this.child || this.state === 'down') throw Object.assign(new Error('The Hermes gateway is not running'), { code: 'gateway_down' }); this.child.stdin.write(JSON.stringify(o) + '\n'); }
  frame(f) {
    if (f && typeof f === 'object' && f.method === 'event') { if (f.params?.type === 'request.cancel') this.open.delete(f.params.payload?.id); return this.emit({ kind: 'event', ...f.params }); }
    if (f && typeof f === 'object' && f.method && f.id !== undefined) { // server -> client request
      if (!SERVER_REQUESTS.has(f.method) || typeof f.id !== 'string') { try { this.write({ jsonrpc: '2.0', id: f.id, error: { code: -32601, message: `${f.method} is not handled by Foxfleet` } }); } catch {} return; }
      this.open.set(f.id, { method: f.method, sid: f.params?.session_id }); return this.emit({ kind: 'request', id: f.id, method: f.method, params: f.params });
    }
    const p = this.pending.get(f?.id); if (!p) return; this.pending.delete(f.id); clearTimeout(p.timer);
    if (f.error) p.reject(Object.assign(new Error(String(f.error.message || 'error').slice(0, 300)), { code: 'upstream', rpc: f.error.code })); else p.resolve(f.result);
  }
  rpc(method, params, ms = this.callMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.nid, timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('The Hermes gateway did not answer in time'), { code: 'timeout' })); }, ms);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  // The allowlisted entry point.
  async call(op, params = {}) {
    if (op === 'info') { await this.ensure(); return { ready: true, epoch: this.epoch, open_requests: [...this.open.keys()] }; }
    if (op === 'respond') { // answer a server request by id, once
      const id = need(str(params.id), 'id'); if (!this.open.has(id)) throw Object.assign(new Error('That request is no longer open'), { code: 'gone' });
      this.open.delete(id); this.write({ jsonrpc: '2.0', id, ...(params.error ? { error: { code: -32000, message: String(params.error).slice(0, 200) } } : { result: params.result && typeof params.result === 'object' ? params.result : {} }) }); return { ok: true };
    }
    await this.ensure();
    if (op === 'attach') { // one owner per session: reuse the live runtime when we have it, otherwise resume the stored session
      const stored = need(str(params.stored_session_id), 'stored_session_id'), rt = this.runtime.get(stored);
      let r; if (rt) { try { r = await this.rpc('session.activate', { session_id: rt }); } catch (e) { if (e.rpc !== 4007) throw e; this.runtime.delete(stored); } }
      if (!r) r = await this.rpc('session.resume', { session_id: stored, cols: 100 });
      if (r?.session_id) this.runtime.set(stored, r.session_id); return r;
    }
    const build = Object.hasOwn(UI_OPS, op) ? UI_OPS[op] : null; if (!build) throw Object.assign(new Error(`${String(op).slice(0, 40)} is not an allowed action`), { code: 'not_allowed' });
    const [method, p] = build(params); const r = await this.rpc(method, p);
    if (op === 'create' && r?.stored_session_id && r?.session_id) this.runtime.set(r.stored_session_id, r.session_id);
    return r;
  }
  stop() { this.state = 'down'; this.readyP = null; try { this.child?.kill(); } catch {} }
}

export function defaultLaunch(gw, profileEnv = {}) {
  return (profile, home) => spawn(gw.cmd, gw.args, { cwd: gw.cwd, env: { ...process.env, ...profileEnv, HERMES_HOME: home, PYTHONUNBUFFERED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
}

// ---------- commands ----------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]; if (!t.startsWith('--')) { a._.push(t); continue; }
    const k = t.slice(2), v = argv[i + 1];
    if (['all', 'install-service', 'no-run', 'no-service', 'help'].includes(k)) a[k] = true; else { a[k] = v; i++; }
  }
  return a;
}
async function choose(discovered, args, cfg) {
  const names = discovered.map((d) => d.profile);
  if (!names.length) { log(`No Hermes profiles found under ${hermesRoot({ override: args['hermes-home'] ?? cfg.hermesHome })}. Is Hermes installed for this user? (set --hermes-home to point at it)`); return { expose: 'selected', profiles: {} }; }
  if (args.all) return { expose: 'all', profiles: Object.fromEntries(names.map((n) => [n, { expose: true }])) };
  if (args.profiles !== undefined) {
    const want = String(args.profiles).split(',').map((s) => s.trim()).filter(Boolean), bad = want.filter((n) => !names.includes(n));
    if (bad.length) throw new Error(`Unknown profile(s): ${bad.join(', ')}. Found: ${names.join(', ')}`);
    return { expose: 'selected', profiles: Object.fromEntries(want.map((n) => [n, { expose: true }])) };
  }
  if (!process.stdin.isTTY) { log('No terminal: sharing every profile found (use --profiles a,b to choose).'); return { expose: 'all', profiles: Object.fromEntries(names.map((n) => [n, { expose: true }])) }; }
  const picked = await checklist(names, chosen(discovered, cfg).length ? chosen(discovered, cfg) : names);
  return { expose: 'selected', profiles: Object.fromEntries(picked.map((n) => [n, { expose: true }])) };
}
function summary(root, discovered, cfg) {
  const names = chosen(discovered, cfg);
  log(`Hermes folder: ${root}`); for (const d of discovered) log(`  ${names.includes(d.profile) ? '[shared]' : '[ not shared ]'} ${d.profile}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv), cmd = args._[0] ?? (loadConfig() ? 'run' : 'help');
  if (typeof WebSocket === 'undefined') { console.error('Node 22 or newer is required (global WebSocket).'); process.exit(2); }
  const cfg = loadConfig();
  try {
    if (cmd === 'help' || args.help) {
      log(`Foxfleet connector ${VERSION}\n\n  doctor                   check Hermes profiles and the native gateway (what was found, whether it starts, how to fix)\n  pair --hub URL --code CODE [--name N] [--all | --profiles a,b] [--install-service] [--hermes-home DIR] [--dashboard-port N]\n  run                      stay connected (what the background service runs)\n  profiles [--all | --profiles a,b]   choose which Hermes profiles to share\n  status | install-service | uninstall-service | unpair\n\nConfig: ${configFile()}`); return;
    }
    if (cmd === 'pair') {
      const hub = checkHub(args.hub || process.env.FOXFLEET_HUB || ''), code = args.code || process.env.FOXFLEET_CODE;
      if (!code) throw new Error('Missing --code (create one in the app: Manage > Machines > Connect a machine)');
      const got = await redeem(hub, code, args.name || os.hostname());
      const next = { hub, machineId: got.machineId, token: got.token, name: got.name, hermesHome: args['hermes-home'], dashboardPort: args['dashboard-port'] ? Number(args['dashboard-port']) : undefined, rescanSeconds: 300 };
      log(`Paired as "${got.name}".`);
      const root = hermesRoot({ override: next.hermesHome }), found = discoverProfiles(root);
      Object.assign(next, await choose(found, args, next)); saveConfig(next); summary(root, found, next);
      if (args['install-service'] || (!args['no-service'] && !args['no-run'] && process.stdin.isTTY && await confirm('Keep Foxfleet connected in the background (start automatically)?'))) { installService(); log('Done. You can close this window.'); return; }
      if (args['no-run']) return;
      log('Running in this window; press Ctrl+C to stop. (Run again later with: node foxfleet-connector.mjs run)'); runLink(next); return;
    }
    if (!cfg) throw new Error('This machine is not paired yet. Create a pairing code in the app and run: node foxfleet-connector.mjs pair --hub <hub> --code <code>');
    if (cmd === 'run') { log(`Foxfleet connector ${VERSION}: ${cfg.name} -> ${cfg.hub}`); runLink(cfg); return; }
    if (cmd === 'profiles') {
      const root = hermesRoot({ override: cfg.hermesHome }), found = discoverProfiles(root); Object.assign(cfg, await choose(found, args, cfg)); saveConfig(cfg); summary(root, found, cfg);
      log('Saved. A running connector picks the change up within its rescan interval (or restart the service).'); return;
    }
    if (cmd === 'doctor') { // checks for this machine's side: Hermes profiles and the native gateway
      const checks = await nativeDoctor(cfg ?? {}); for (const c of checks) log(`${c.status === 'ok' ? '[ok]  ' : c.status === 'warn' ? '[warn]' : '[FAIL]'} ${c.id}: ${c.message}${c.fix ? `\n        fix: ${c.fix}` : ''}`);
      if (args.json) log(JSON.stringify(checks)); if (checks.some((c) => c.status === 'fail')) process.exit(1); return;
    }
    if (cmd === 'status') { const root = hermesRoot({ override: cfg.hermesHome }); log(`Machine: ${cfg.name}\nHub: ${cfg.hub}\nConfig: ${configFile()} (0600)`); summary(root, discoverProfiles(root), cfg); return; }
    if (cmd === 'install-service') { installService(); return; }
    if (cmd === 'uninstall-service') { uninstallService(); return; }
    if (cmd === 'unpair') { uninstallService(); fs.rmSync(configFile(), { force: true }); log('Unpaired and removed the local token. Remove the machine in the app too (Manage > Machines) so its agents disappear.'); return; }
    throw new Error(`Unknown command "${cmd}". Run with "help".`);
  } catch (e) { console.error(e.message || String(e)); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
