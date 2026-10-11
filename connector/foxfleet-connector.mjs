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
// Commands: pair | run | profiles | status | doctor [--fix [--yes]] | agent-note | allow-media | install-service | uninstall-service | unpair | help
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.3.8-alpha';
/** What this connector can do for the hub (reported in the profiles frame; the hub shows it as the Media row of an agent). */
export const FEATURES = ['media', 'mediaRoots', 'mediaCheck', 'agentNote'];
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
    g = new HermesGateway({ profile: name, home: t.home, launch: defaultLaunch(gw), emit: (ev) => send({ t: 'ui-ev', agent: name, ev }), log, note: () => fallbackNote(loadConfig() ?? cfg, root, t.home) });
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
    if (cur.agentNote === true) for (const [n, t] of next) { // the user opted in: keep the installed note current after a connector upgrade
      try { const note = profileNote(cur, root, t.home); if (noteStatus(t.home, note, cur).status === 'stale') { applyNote(t.home, note); log(`Profile ${n}: agent note updated to v${note.hash}.`); } } catch (e) { log(`Profile ${n}: agent note not updated: ${e.message}`); }
    }
    agents = next; return [...next.keys()];
  }
  const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };
  const mediaOk = mediaLimiter(Number(cfg.mediaPerMinute) || 60);
  function announce(force = false) {
    const names = scan(), key = names.join(',');
    if (!force && key === lastSent) return; lastSent = key;
    send({ t: 'profiles', os: process.platform, version: VERSION, features: FEATURES, profiles: names.map((profile) => ({ profile })) }); send({ t: 'ui-caps', caps: uiCaps() });
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
    if (m.t === 'media-get') { // hub -> connector: one local file the agent named in a MEDIA: tag
      if (!mediaOk()) return send({ t: 'media-meta', id: m.id, ok: false, code: 'rate', error: 'Too many files requested; try again in a minute' });
      const cur = loadConfig() ?? cfg, prof = discoverProfiles(root).find((p) => p.profile === m.agent), home = prof?.home;
      const c = checkMedia(m.path, mediaRoots({ root, home, cfg: cur }), { maxBytes: Number(cur.mediaMaxBytes) || MEDIA_DEFAULT_MAX });
      if (!c.ok) return send({ t: 'media-meta', id: m.id, ok: false, code: c.code, error: c.error });
      send({ t: 'media-meta', id: m.id, ok: true, size: c.size, mime: c.mime, name: c.name });
      const rs = fs.createReadStream(c.path, { highWaterMark: 48 * 1024 }); let sent = 0;
      rs.on('data', (b) => { sent += b.length; if (sent <= c.size + 1024) send({ t: 'media-data', id: m.id, b: b.toString('base64') }); });
      rs.on('end', () => send({ t: 'media-end', id: m.id })); rs.on('error', () => send({ t: 'media-meta', id: m.id, ok: false, code: 'io', error: 'Read failed' }));
      return;
    }
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
  // The tunnel in front of the hub can drop silently (a half-open socket after a proxy restart). The hub pings every 25 s, so 75 s of
  // silence means the link is dead: drop it and reconnect (the Hermes gateways below keep running, so agent turns are not restarted).
  const SILENT_MS = Number(process.env.FOXFLEET_LINK_SILENT_MS) || 75_000;
  const jitter = (ms) => Math.round(ms * (0.5 + Math.random() / 2));
  function connect() {
    if (stopped) return;
    const sock = ws = new WebSocket(wsUrl, ['foxfleet.v1', cfg.token]);
    let lastRx = Date.now(), over = false, watch;
    const lost = () => {
      if (over) return; over = true; clearInterval(watch);
      for (const e of reqs.values()) { e.cancelled = true; try { (e.sock ?? e.up)?.destroy(); } catch {} } reqs.clear();
      if (stopped) return;
      if (!everOpened && ++refusals >= 3) log('The hub keeps refusing this machine (it may have been removed or its token rotated). Create a new pairing code in the app and run: node foxfleet-connector.mjs pair --hub <hub> --code <code>');
      else log(`Disconnected; retrying in ${Math.round(delay / 100) / 10}s`);
      everOpened = false; setTimeout(connect, jitter(delay)); delay = Math.min(delay * 2, 60000);
    };
    sock.onopen = () => { delay = 1000; everOpened = true; refusals = 0; lastRx = Date.now(); onState('connected'); log('Connected to the hub.'); lastSent = ''; announce(true);
      watch = setInterval(() => { if (Date.now() - lastRx > SILENT_MS) { log('The hub link went quiet; reconnecting.'); try { sock.close(); } catch {} setTimeout(lost, 2000).unref?.(); } }, Math.max(1000, Math.min(15_000, SILENT_MS / 3))); watch.unref?.(); };
    sock.onmessage = (ev) => {
      lastRx = Date.now();
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === 'ping') return send({ t: 'pong' });
      if (m.t === 'registered') { onState('registered', m); if (m.agents?.length) log(`Sharing ${m.agents.length} profile(s): ${m.agents.map((a) => (a.agent === a.profile ? a.profile : `${a.profile} (as ${a.agent})`)).join(', ')}`); else log('Connected; no profiles are shared yet. Run: node foxfleet-connector.mjs profiles'); return; }
      handle(m).catch(() => send({ t: 'error', id: m.id }));
    };
    sock.onclose = lost;
    sock.onerror = () => { setTimeout(lost, 1500).unref?.(); }; // a failed handshake (a 502 from the tunnel) must also lead to a retry, whatever the runtime reports
  }
  connect(); timer = setInterval(() => announce(false), Math.max(30, Number(cfg.rescanSeconds) || 300) * 1000); timer.unref?.();
  return { stop() { stopped = true; clearInterval(timer); for (const g of gateways.values()) g.stop(); try { ws.close(); } catch {} } };
}


// ---------- local media for MEDIA: tags (the hub cannot read this machine's disk, so it asks here) ----------
// An agent that writes `MEDIA:/path/chart.png` means a file on THIS computer. The hub only asks for paths the agent itself mentioned in
// a reply for that user; this side still decides, and says no unless: the real path (symlinks resolved) is inside an allowed root,
// the extension is a deliverable media/document type, the file is a regular file under the size cap, and its first bytes really look like
// that type (an HTML page named x.png is refused). Secrets directories are never served, whatever the roots say.
export const MEDIA_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m2a: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', tsv: 'text/plain', rtf: 'application/rtf', epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip', tar: 'application/x-tar', gz: 'application/gzip', tgz: 'application/gzip', '7z': 'application/x-7z-compressed',
  kml: 'application/vnd.google-earth.kml+xml', kmz: 'application/vnd.google-earth.kmz', gpx: 'application/gpx+xml', geojson: 'application/geo+json',
};
const MEDIA_DENY_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.git', '.password-store']);
const MEDIA_DEFAULT_MAX = 25 * 1024 * 1024;
const sub = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
export function mediaRoots({ root, home, cfg = {}, env = process.env, tmp = os.tmpdir() } = {}) {
  // Where Hermes writes what it makes: ~/.hermes/cache/{images,audio,videos,documents,screenshots,generated} and the older *_cache folders, in the root
  // and in each profile's own home (profiles/<name>/...), plus the working folders agents commonly save into.
  const names = ['image_cache', 'audio_cache', 'video_cache', 'document_cache', 'browser_screenshots', 'cache', 'workspace', 'media', 'outputs', 'output', 'generated', 'screenshots', 'downloads'];
  const homes = [home, root, ...profileHomes(root)].filter(Boolean);
  const base = homes.flatMap((h) => names.map((n) => path.join(h, n)));
  const list = (v) => String(v ?? '').split(path.delimiter);
  // HERMES_MEDIA_ALLOW_DIRS is Hermes' own operator allow-list for delivery: honour it so one setting covers both.
  const extra = [...(Array.isArray(cfg.mediaRoots) ? cfg.mediaRoots : []), ...list(env.FOXFLEET_MEDIA_ROOTS), ...list(env.HERMES_MEDIA_ALLOW_DIRS), cfg.uiGatewayCwd].filter((x) => typeof x === 'string' && path.isAbsolute(x));
  return [...new Set([...base, tmp, ...extra].map(real).filter(Boolean))];
}
function profileHomes(root) { try { return root ? fs.readdirSync(path.join(root, 'profiles'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, 'profiles', d.name)) : []; } catch { return []; } }
/** `doctor` lines for media: what is shared, and what an agent would get stuck on. */
export function mediaDoctor(cfg, { root, env = process.env } = {}) {
  const out = [], roots = mediaRoots({ root, cfg, env }), custom = (Array.isArray(cfg.mediaRoots) ? cfg.mediaRoots : []).filter((d) => !real(d));
  out.push({ id: 'media', status: 'ok', message: `media: ${roots.length} shared folder(s) (Hermes caches, workspace, temp${cfg.mediaRoots?.length ? `, ${cfg.mediaRoots.length} of yours` : ''}); files up to ${Math.round((Number(cfg.mediaMaxBytes) || MEDIA_DEFAULT_MAX) / 1048576)} MB; connector ${VERSION}` });
  for (const d of custom) out.push({ id: 'media-root', status: 'warn', message: `mediaRoots entry ${d} does not exist on this machine`, fix: 'Remove it from the connector config, or create the folder.' });
  if (root && !roots.some((r) => /(^|[\\/])(cache|image_cache)$/.test(r))) out.push({ id: 'media-cache', status: 'warn', message: 'no Hermes image cache folder yet', fix: 'Normal until an agent makes its first picture. If an agent saves pictures elsewhere, run: foxfleet connector allow-media "<folder>"' });
  return out;
}
/** `allow-media <dir>`: share one more folder (an absolute path that exists). Returns the new list. */
export function allowMediaRoot(cfg, dir) {
  const d = String(dir ?? '').trim(), rp = d && path.isAbsolute(d) ? real(d) : null;
  if (!rp) throw new Error('Give an absolute path to a folder that exists on this machine, e.g. allow-media "/home/me/projects/out"');
  if (!fs.statSync(rp).isDirectory()) throw new Error('That is a file; share its folder instead');
  if (rp === path.parse(rp).root || rp === os.homedir()) throw new Error('Too broad: share a specific folder, not the whole disk or your home folder');
  if (rp.split(path.sep).some((c) => MEDIA_DENY_DIRS.has(c))) throw new Error('That location holds credentials and is never shared');
  const next = [...new Set([...(Array.isArray(cfg.mediaRoots) ? cfg.mediaRoots : []), rp])]; return { ...cfg, mediaRoots: next };
}
/** Magic-number check: does this file's start really look like its extension says? Returns the mime to serve, or null. */
export function sniffMedia(head, ext) {
  const at = (o, s) => head.length >= o + s.length && head.subarray(o, o + s.length).toString('latin1') === s, hex = (h) => head.subarray(0, h.length / 2).toString('hex') === h;
  const riff = (t) => at(0, 'RIFF') && at(8, t), ftyp = at(4, 'ftyp');
  const ok = {
    png: () => hex('89504e47'), jpg: () => hex('ffd8ff'), jpeg: () => hex('ffd8ff'), gif: () => at(0, 'GIF8'), webp: () => riff('WEBP'), bmp: () => at(0, 'BM'), avif: () => ftyp,
    mp4: () => ftyp, m4v: () => ftyp, '3gp': () => ftyp, mov: () => ftyp || ['moov', 'mdat', 'wide', 'free', 'skip'].some((t) => at(4, t)), webm: () => hex('1a45dfa3'), mkv: () => hex('1a45dfa3'), avi: () => riff('AVI '),
    mp3: () => at(0, 'ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0), m2a: () => at(0, 'ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0), wav: () => riff('WAVE'), ogg: () => at(0, 'OggS'), opus: () => at(0, 'OggS'),
    m4a: () => ftyp, aac: () => head[0] === 0xff && (head[1] & 0xf0) === 0xf0, flac: () => at(0, 'fLaC'),
    pdf: () => at(0, '%PDF'), rtf: () => at(0, '{\\rtf'), zip: () => at(0, 'PK'), docx: () => at(0, 'PK'), xlsx: () => at(0, 'PK'), pptx: () => at(0, 'PK'), odt: () => at(0, 'PK'), ods: () => at(0, 'PK'), odp: () => at(0, 'PK'), epub: () => at(0, 'PK'), kmz: () => at(0, 'PK'),
    doc: () => hex('d0cf11e0'), xls: () => hex('d0cf11e0'), ppt: () => hex('d0cf11e0'), gz: () => hex('1f8b'), tgz: () => hex('1f8b'), '7z': () => at(0, '7z'), tar: () => true,
  }[ext];
  if (ok) return ok() ? MEDIA_MIME[ext] : null;
  return MEDIA_MIME[ext] && !head.includes(0) ? MEDIA_MIME[ext] : null; // text-like types: no NUL bytes
}
/** Decides whether `raw` (a path the agent wrote) may leave this machine. */
export function checkMedia(raw, roots, { maxBytes = MEDIA_DEFAULT_MAX, home = os.homedir() } = {}) {
  let p = String(raw ?? '').trim(); if (!p || p.length > 4096 || p.includes('\0')) return { ok: false, code: 'bad_path', error: 'Not a usable path' };
  if (p === '~' || p.startsWith('~/')) p = path.join(home, p.slice(1));
  if (!path.isAbsolute(p) || (process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(p))) return { ok: false, code: 'bad_path', error: 'Not an absolute path on this machine' };
  const ext = path.extname(p).slice(1).toLowerCase(); if (!MEDIA_MIME[ext]) return { ok: false, code: 'type', error: 'This file type is not delivered' };
  const rp = real(p); if (!rp) return { ok: false, code: 'missing', error: 'File not found on this machine' };
  if (!roots.some((r) => sub(r, rp))) return { ok: false, code: 'outside', error: 'That location is not shared with the hub (set mediaRoots in the connector config)' };
  if (rp.split(path.sep).some((c) => MEDIA_DENY_DIRS.has(c))) return { ok: false, code: 'denied', error: 'Denied' };
  if (!MEDIA_MIME[path.extname(rp).slice(1).toLowerCase()]) return { ok: false, code: 'type', error: 'This file type is not delivered' }; // a symlink may not smuggle a different type
  let st; try { st = fs.statSync(rp); } catch { return { ok: false, code: 'missing', error: 'File not found on this machine' }; }
  if (!st.isFile()) return { ok: false, code: 'type', error: 'Not a regular file' };
  if (st.size > maxBytes) return { ok: false, code: 'too_big', error: `File is larger than ${Math.round(maxBytes / 1048576)} MB` };
  let head = Buffer.alloc(0); try { const fd = fs.openSync(rp, 'r'); try { const b = Buffer.alloc(4096); head = b.subarray(0, fs.readSync(fd, b, 0, 4096, 0)); } finally { fs.closeSync(fd); } } catch { return { ok: false, code: 'missing', error: 'File not readable' }; }
  const mime = sniffMedia(head, ext); if (!mime) return { ok: false, code: 'sniff', error: 'The file does not look like its extension says' };
  return { ok: true, path: rp, size: st.size, mime, name: path.basename(rp) };
}
/** At most `perMinute` fetches a minute, so a looping agent cannot drain the disk or the tunnel. */
export function mediaLimiter(perMinute = 60, now = () => Date.now()) { let tokens = perMinute, last = now(); return () => { const t = now(); tokens = Math.min(perMinute, tokens + ((t - last) / 60000) * perMinute); last = t; if (tokens < 1) return false; tokens -= 1; return true; }; }

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
  create: (p) => ['session.create', { cols: 100, source: SESSION_SOURCE, ...(str(p.title, 300) ? { title: p.title } : {}), ...(str(p.idempotency_key, 80) ? { idempotency_key: p.idempotency_key } : {}) }],
  sessions: () => ['session.list', {}],
  'events.since': (p) => ['session.events.since', { session_id: need(str(p.session_id), 'session_id'), last_seen: Number.isInteger(p.last_seen) ? p.last_seen : 0 }],
  submit: (p) => { if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > MAX_TEXT) throw Object.assign(new Error('text is required'), { code: 'bad_params' }); return ['prompt.submit', { session_id: need(str(p.session_id), 'session_id'), text: p.text, ...(p.queued === true ? { queued: true } : {}) }]; },
  // A picture the user sent: Hermes (image.attach_bytes) keeps it for the next prompt.submit of this session. Base64 only, size-capped (the tunnel frame limit is 4 MB).
  attachimg: (p) => { const b = need(str(p.content_base64, 3_400_000), 'content_base64'); if (!/^[A-Za-z0-9+/=\r\n]+$/.test(b)) throw Object.assign(new Error('content_base64 is not base64'), { code: 'bad_params' }); return ['image.attach_bytes', { session_id: need(str(p.session_id), 'session_id'), content_base64: b, ...(str(p.ext, 8) && /^[a-z0-9]+$/i.test(p.ext) ? { ext: p.ext.toLowerCase() } : {}), ...(str(p.filename, 120) ? { filename: p.filename.replace(/[^\w.-]/g, '_') } : {}) }]; },
  steer: (p) => ['session.steer', { session_id: need(str(p.session_id), 'session_id'), text: need(str(p.text, MAX_TEXT), 'text') }],
  redirect: (p) => ['session.redirect', { session_id: need(str(p.session_id), 'session_id'), text: need(str(p.text, MAX_TEXT), 'text') }],
  interrupt: (p) => ['session.interrupt', { session_id: need(str(p.session_id), 'session_id') }],
  catalog: (p) => ['commands.catalog', { ...(str(p?.session_id) ? { session_id: p.session_id } : {}) }],
  resolve: (p) => ['command.resolve', { name: need(str(p.name, 100), 'name') }],
  dispatch: (p) => { const name = need(str(p.name, 100), 'name').replace(/^\//, ''); if (!DISPATCH_OK.has(name)) throw Object.assign(new Error(`/${name} is not available remotely`), { code: 'not_allowed' }); return ['command.dispatch', { name, arg: typeof p.arg === 'string' ? p.arg.slice(0, 2000) : '', session_id: need(str(p.session_id), 'session_id') }]; },
  // /model: session-scoped switch. `--global` / `--once` flags are refused here; a profile default is changed in Hermes itself.
  setmodel: (p) => { const v = need(str(p.value, 300), 'value'); if (/(^|\s)--(global|once)\b/.test(v)) throw Object.assign(new Error('Changing the profile default is not available remotely'), { code: 'not_allowed' }); return ['config.set', { key: 'model', value: v, session_id: need(str(p.session_id), 'session_id') }]; },
  // /busy: the mode is a PROFILE-wide Hermes setting (display.busy_input_mode), not per conversation. `status` only reads it.
  busy: (p) => { const m = need(str(p.mode, 20), 'mode'); if (!['queue', 'steer', 'interrupt', 'status'].includes(m)) throw Object.assign(new Error('mode must be queue, steer, interrupt or status'), { code: 'bad_params' }); return ['config.set', { key: 'busy', value: m }]; },
  models: (p) => ['model.options', { ...(str(p.session_id) ? { session_id: p.session_id } : {}), refresh: p.refresh === true }],
  lock: (p) => ['clarify.lock', { request_id: need(str(p.request_id), 'request_id'), question_id: need(str(p.question_id), 'question_id'), answer: typeof p.answer === 'string' ? p.answer.slice(0, 4000) : '' }],
};

// ---------- agent awareness: tell the Hermes agent it is in a FoxFleet chat (see docs/AGENT-AWARENESS.md) ----------
// Sessions are created with source "foxfleet", so Hermes stops describing the chat as its terminal UI. The note below goes into the profile's
// config.yaml as platform_hints.foxfleet.replace (a Hermes setting that lands in the cached system prompt), ONLY after the user said yes.
// Without that, the same text is sent once with the first message of a new chat (fallback).
export const SESSION_SOURCE = 'foxfleet';
export const NOTE_BEGIN = '# foxfleet-agent-note:begin (managed by the Foxfleet connector; remove with: foxfleet-connector agent-note remove)';
export const NOTE_END = '# foxfleet-agent-note:end';
export const NOTE_TAG = ['<foxfleet-note>', '</foxfleet-note>'];
const REMOTE_COMMANDS = [...DISPATCH_OK, 'model', 'busy'];
const tilde = (p, home = os.homedir()) => (p === home ? '~' : p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
/** The text Hermes shows the agent. Pure: same inputs, same bytes (it sits in the cached prompt prefix). `hash` changes when any word changes. */
export function agentNote({ cfg = {}, roots = [], home = os.homedir(), features = FEATURES } = {}) {
  const maxMb = Math.round((Number(cfg.mediaMaxBytes) || MEDIA_DEFAULT_MAX) / 1048576), upload = typeof cfg.uploadDir === 'string' && cfg.uploadDir ? cfg.uploadDir : '~/foxfleet-uploads';
  const shown = [...new Set(roots.map((r) => tilde(r, home)))].sort().slice(0, 6);
  // Short on purpose: it sits in every prompt. Only what differs from a terminal, once.
  const lines = [
    'You are in FoxFleet, a chat app (often on a phone), not a terminal.',
    'Markdown renders. Keep replies short; put long output in a file. No ANSI, TUI keys or interactive terminal programs.',
    features.includes('media')
      ? `Send a file: MEDIA:/absolute/path on its own line (images/video show inline). Only from ${shown.join(', ') || '(none yet)'}, up to ${maxMb} MB.`
      : 'Files: no attachment channel; give the absolute path as text.',
    `User uploads are in ${upload}.`,
    'Approvals and questions show as tap-to-answer cards: ask one question with short options.',
    "To react to the user's message, put REACT: ❤️ (any one emoji) on its own line. Use it sparingly.",
    `Slash commands that work here: ${REMOTE_COMMANDS.map((c) => '/' + c).join(' ')}.`,
  ];
  const body = lines.join('\n'), hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
  return { hash, text: `${lines[0]} (foxfleet-note v${hash})\n${lines.slice(1).join('\n')}`, version: hash };
}
const EOL = (t) => (t.includes('\r\n') ? '\r\n' : '\n');
const markerRe = (w) => new RegExp(`^\\s*#\\s*foxfleet-agent-note:${w}\\b`);
/** Pure text edit of config.yaml (no YAML library, everything outside our marked block is left byte-for-byte). action: 'install' | 'remove'. */
export function editConfigYaml(src, noteText, action = 'install') {
  const eol = EOL(src), lines = src.split(/\r?\n/), b = lines.findIndex((l) => markerRe('begin').test(l));
  const e = b >= 0 ? lines.findIndex((l, i) => i > b && markerRe('end').test(l)) : -1;
  const block = (ind) => [ind + NOTE_BEGIN, `${ind}foxfleet:`, `${ind}  replace: |-`, ...noteText.split('\n').map((l) => `${ind}    ${l}`), ind + NOTE_END];
  const ownBlock = () => [NOTE_BEGIN, 'platform_hints:', ...block('  ').slice(1)];
  const join = (ls) => ls.join(eol);
  if (b >= 0 && e > b) {
    const ind = /^\s*/.exec(lines[b])[0];
    if (action === 'remove') {
      const rest = [...lines.slice(0, b), ...lines.slice(e + 1)], k = b - 1;
      if (k >= 0 && /^platform_hints\s*:\s*(#.*)?$/.test(rest[k]) && !(rest[k + 1] ?? '').startsWith(' ') ) rest[k] = 'platform_hints: {}';
      return { text: join(rest), changed: true };
    }
    const own = /^platform_hints\s*:\s*$/.test(lines[b + 1] ?? ''); // the block owns the whole key when we created it
    const next = [...lines.slice(0, b), ...(own ? ownBlock() : block(ind)), ...lines.slice(e + 1)]; const out = join(next); return { text: out, changed: out !== src };
  }
  if (b >= 0) throw Object.assign(new Error('the Foxfleet note block in config.yaml is damaged (a begin marker without its end)'), { code: 'damaged' });
  if (action === 'remove') return { text: src, changed: false };
  const k = lines.findIndex((l) => /^platform_hints\s*:/.test(l));
  if (k < 0) {
    const tail = src.length && !src.endsWith('\n') ? eol : ''; return { text: src + tail + join(ownBlock()) + eol, changed: true };
  }
  const rest = lines[k].replace(/^platform_hints\s*:/, '').replace(/\s+#.*$/, '').trim();
  if (rest !== '' && rest !== '{}') throw Object.assign(new Error('platform_hints in config.yaml is written in a style the connector does not edit (inline or anchored)'), { code: 'unsupported-yaml' });
  let j = k + 1; while (j < lines.length && (lines[j].trim() === '' || /^\s*#/.test(lines[j]))) j++;
  const child = j < lines.length ? /^(\s+)\S/.exec(lines[j]) : null, ind = rest === '' && child ? child[1] : '  ';
  if (rest === '' && child) for (let i = j; i < lines.length && (/^\s/.test(lines[i]) || lines[i] === ''); i++) if (new RegExp(`^${ind}foxfleet\\s*:`).test(lines[i])) throw Object.assign(new Error('config.yaml already has its own platform_hints.foxfleet (yours is kept)'), { code: 'user-owned' });
  const head = rest === '{}' ? ['platform_hints:'] : [lines[k]];
  const next = [...lines.slice(0, k), ...head, ...block(ind), ...lines.slice(k + 1)]; return { text: join(next), changed: true };
}
/** Reads the note back out of a config.yaml (only from our marked block). */
export function readNote(src) {
  const lines = src.split(/\r?\n/), b = lines.findIndex((l) => markerRe('begin').test(l)), e = lines.findIndex((l, i) => i > b && markerRe('end').test(l));
  if (b < 0 || e < 0) return null; const r = lines.findIndex((l, i) => i > b && i < e && /^\s*replace:\s*\|-\s*$/.test(l)); if (r < 0) return null; const body = lines.slice(r + 1, e); const ind = /^\s*/.exec(body[0] ?? '')[0].length;
  return body.map((l) => l.slice(ind)).join('\n');
}
/** One profile's state: installed | stale | missing | user-owned | disabled | unsupported. `present` is true when our block is in the file. */
export function noteStatus(home, note, cfg = {}, support = null) {
  const file = path.join(home, 'config.yaml'); let src = ''; try { src = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const cur = readNote(src), present = cur !== null;
  const userOwned = !present && /^platform_hints\s*:\s*$/m.test(src) && /^\s+foxfleet\s*:/m.test(src.slice(src.search(/^platform_hints\s*:/m)));
  let status = present ? (cur === note.text ? 'installed' : 'stale') : userOwned ? 'user-owned' : 'missing';
  if (cfg.agentNote === false) status = 'disabled'; else if (support && support.hints === false) status = 'unsupported';
  return { status, present, file };
}
/** Does the installed Hermes know platform_hints and take `source` on session.resume? true/false, or null when it cannot be asked. */
export function hermesNoteSupport(gw, run = spawnSync) {
  if (!gw || !/python/i.test(path.basename(gw.cmd))) return null;
  const code = "import json;from hermes_cli.config_defaults import DEFAULT_CONFIG as C;from tui_gateway.contracts.sessions import SessionResumeParams as R,SessionCreateParams as S;print(json.dumps({'hints':'platform_hints' in C,'source':'source' in R.model_fields and 'source' in S.model_fields}))";
  try { const r = run(gw.cmd, ['-c', code], { cwd: gw.cwd, timeout: 30_000, encoding: 'utf8' }); if (r.status !== 0) return null; return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
}
/** Writes (or removes) our block in one profile's config.yaml with a one-time backup and an atomic rename. Returns { changed, backup? }. */
export function applyNote(home, note, action = 'install') {
  const file = path.join(home, 'config.yaml'); let src = ''; try { src = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const r = editConfigYaml(src, note.text, action); if (!r.changed) return { changed: false };
  let backup; if (src && !fs.existsSync(file + '.foxfleet.bak')) { fs.copyFileSync(file, file + '.foxfleet.bak'); backup = file + '.foxfleet.bak'; }
  const mode = (() => { try { return fs.statSync(file).mode & 0o777; } catch { return 0o600; } })(), tmp = `${file}.foxfleet.tmp`;
  fs.writeFileSync(tmp, r.text, { mode }); fs.renameSync(tmp, file); return { changed: true, ...(backup ? { backup } : {}) };
}
/** What the fallback prepends to the first message of a NEW chat (the hub removes it again when it shows the transcript). */
export const wrapNote = (note, text) => `${NOTE_TAG[0]}\n${note.text}\n${NOTE_TAG[1]}\n\n${text}`;
/** The note to prepend to a new chat's first message, or null: opted out, or the profile's config.yaml already carries the current note. */
export function fallbackNote(cfg, root, home) {
  if (cfg.agentNote === false) return null;
  const n = profileNote(cfg, root, home); return noteStatus(home, n, cfg).status === 'installed' ? null : n;
}
/** The folders the note names: derived from settings, never from what exists right now (a Hermes cache folder appears after the first image, and the note must not change then: it sits in the cached prompt). */
export function noteRoots({ home, cfg = {}, tmp = os.tmpdir() } = {}) {
  const extra = [...(Array.isArray(cfg.mediaRoots) ? cfg.mediaRoots : []), cfg.uiGatewayCwd].filter((x) => typeof x === 'string' && path.isAbsolute(x));
  return [...new Set([path.join(home, 'cache'), path.join(home, 'workspace'), tmp, ...extra])];
}
export function profileNote(cfg, root, home) { return agentNote({ cfg, roots: noteRoots({ home, cfg }), home: os.homedir() }); }

/** doctor rows: one per shared profile, saying whether Hermes is told it is in FoxFleet and how to change that. */
export function noteDoctor(cfg, { root, support = null } = {}) {
  const out = [], found = discoverProfiles(root), names = chosen(found, cfg);
  for (const pr of found.filter((x) => names.includes(x.profile))) {
    const note = profileNote(cfg, root, pr.home), st = noteStatus(pr.home, note, cfg, support), id = `agent-note:${pr.profile}`;
    const fb = ' Until then the note rides on the first message of each new chat.';
    if (st.status === 'installed') out.push({ id, status: 'ok', message: `profile ${pr.profile}: agent note installed (v${note.hash}) in ${st.file}` });
    else if (st.status === 'disabled') out.push({ id, status: st.present ? 'warn' : 'ok', message: `profile ${pr.profile}: agent note is off (agentNote: false)${st.present ? ', but a block is still in config.yaml' : ''}`, ...(st.present ? { fix: 'node foxfleet-connector.mjs agent-note remove' } : {}) });
    else if (st.status === 'stale') out.push({ id, status: 'warn', message: `profile ${pr.profile}: the installed agent note is out of date (this connector writes v${note.hash}).${fb}`, fix: 'node foxfleet-connector.mjs doctor --fix' });
    else if (st.status === 'user-owned') out.push({ id, status: 'warn', message: `profile ${pr.profile}: config.yaml has its own platform_hints.foxfleet, so the connector leaves it alone.${fb}`, fix: 'Merge the text from: node foxfleet-connector.mjs agent-note show' });
    else if (st.status === 'unsupported') out.push({ id, status: 'warn', message: `profile ${pr.profile}: this Hermes has no platform_hints setting.${fb}`, fix: 'Update Hermes (hermes update) to let the note live in the system prompt.' });
    else out.push({ id, status: 'warn', message: `profile ${pr.profile}: agent note not installed; Hermes may think this chat is its terminal.${fb}`, fix: 'node foxfleet-connector.mjs doctor --fix   (asks first; or: agent-note install --yes)' });
  }
  return out;
}
/** `agent-note install` / `doctor --fix`: asks first unless --yes. Returns a list of result lines. */
export async function installNotes(cfg, { root, yes = false, ask = confirm, gw = null, support = hermesNoteSupport(gw), save = saveConfig, explicit = true } = {}) {
  const out = [];
  if (cfg.agentNote === false && !explicit) return ['agent note is off (agentNote: false); not touching config.yaml. Turn it on with: agent-note install'];
  const found = discoverProfiles(root), names = chosen(found, cfg), targets = found.filter((x) => names.includes(x.profile));
  if (support && support.hints === false) return ['This Hermes has no platform_hints setting, so nothing was written. The note is sent with the first message of each new chat instead. Update Hermes to use the system prompt.'];
  const note = profileNote(cfg, root, targets[0]?.home ?? root); // wording and shape; each profile gets its own folder names below
  if (cfg.agentNote !== true && !yes) {
    log(`The Foxfleet note tells Hermes agents they are in a FoxFleet chat (Markdown ok, MEDIA: files, cards, no terminal features):\n\n${note.text}\n\nIt would be added to config.yaml (platform_hints.foxfleet) of: ${targets.map((x) => x.profile).join(', ') || '(no shared profile)'}. A backup is kept as config.yaml.foxfleet.bak and you can undo it with: agent-note remove`);
    if (!process.stdin.isTTY || !(await ask('Write it?', false))) { save({ ...cfg, agentNote: 'message' }); return ['Not written. The note will be sent with the first message of each new chat instead (turn that off with agentNote: false in the connector config).'];
    }
  }
  for (const pr of targets) {
    try { const mine = profileNote(cfg, root, pr.home), r = applyNote(pr.home, mine, 'install'); out.push(`profile ${pr.profile}: ${r.changed ? 'note written' + (r.backup ? ` (backup: ${r.backup})` : '') : 'already up to date'} (v${mine.hash})`); }
    catch (e) { out.push(`profile ${pr.profile}: skipped: ${e.message}`); }
  }
  save({ ...cfg, agentNote: true }); return out;
}
export function removeNotes(cfg, { root, save = saveConfig } = {}) {
  const out = [], found = discoverProfiles(root);
  for (const pr of found) { try { const r = applyNote(pr.home, { text: '' }, 'remove'); if (r.changed) out.push(`profile ${pr.profile}: note removed`); } catch (e) { out.push(`profile ${pr.profile}: ${e.message}`); } }
  save({ ...cfg, agentNote: false }); out.push('agentNote is now off: nothing is written and nothing is sent with new chats. Turn it back on with: agent-note install'); return out;
}

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
  constructor({ profile, home, launch, emit, log: lg = () => {}, readyMs = 60_000, callMs = 30_000, note = () => null }) {
    Object.assign(this, { profile, home, launch, emit, lg, readyMs, callMs, note }); this.fresh = new Map(); this.noSource = false; this.state = 'stopped'; this.pending = new Map(); this.open = new Map(); this.runtime = new Map();
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
        // 'exit' can fire before the last stdout lines (an answer written just before the process died) have been read; 'close' comes after
        // the streams ended. Wait for it (bounded, in case a grandchild keeps the pipe open) so a reply that did arrive is never reported as lost.
        let over = false, grace; const gone = (code) => { if (over) return; over = true; clearTimeout(grace); clearTimeout(timer); this.exited(code, fail); };
        child.stdin.on('error', () => {});
        child.on('exit', (code) => { clearTimeout(timer); grace = setTimeout(() => gone(code), 500); grace.unref?.(); });
        child.on('close', (code) => gone(code));
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
  // `source` is how Hermes learns the chat surface. A Hermes that predates it rejects the unknown parameter (extra="forbid"): retry once without it and remember.
  async withSource(method, p) {
    const q = { ...p }; if (this.noSource) delete q.source; else q.source = SESSION_SOURCE;
    try { return await this.rpc(method, q); } catch (e) {
      if (!this.noSource && e.rpc === -32602 && /source|extra|unexpected|forbidden/i.test(String(e.message))) { this.noSource = true; this.lg(`This Hermes does not accept "source" on ${method}; continuing without it.`); delete q.source; return this.rpc(method, q); }
      throw e;
    }
  }
  /** Remember (for this runtime session) that its first prompt should carry the note. Only when the profile config does not already hold the current note. */
  markFresh(sid) { let n = null; try { n = this.note(); } catch { /* never block a chat on this */ } if (n) this.fresh.set(sid, n); }
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
      if (!r) r = await this.withSource('session.resume', { session_id: stored, cols: 100 });
      if (r?.session_id) { this.runtime.set(stored, r.session_id); if (!r.message_count && !(r.messages?.length)) this.markFresh(r.session_id); } return r;
    }
    const build = Object.hasOwn(UI_OPS, op) ? UI_OPS[op] : null; if (!build) throw Object.assign(new Error(`${String(op).slice(0, 40)} is not an allowed action`), { code: 'not_allowed' });
    const [method, p] = build(params);
    if (op === 'submit' && typeof p.text === 'string' && this.fresh.has(p.session_id)) { // fallback awareness: the note rides on the first message of a new chat
      const n = this.fresh.get(p.session_id); this.fresh.delete(p.session_id); if (n) p.text = wrapNote(n, p.text);
    }
    const r = method === 'session.create' ? await this.withSource(method, p) : await this.rpc(method, p);
    if (op === 'create' && r?.stored_session_id && r?.session_id) { this.runtime.set(r.stored_session_id, r.session_id); this.markFresh(r.session_id); }
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
    if (['all', 'install-service', 'no-run', 'no-service', 'help', 'fix', 'yes'].includes(k)) a[k] = true; else { a[k] = v; i++; }
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
      log(`Foxfleet connector ${VERSION}\n\n  allow-media <folder>     share one more folder so agents can send files from it\n  agent-note [status|show|install|remove]  tell Hermes agents they are in a FoxFleet chat (asks before touching config.yaml)\n  doctor [--fix]           check Hermes profiles and the native gateway (what was found, whether it starts, how to fix)\n  pair --hub URL --code CODE [--name N] [--all | --profiles a,b] [--install-service] [--hermes-home DIR] [--dashboard-port N]\n  run                      stay connected (what the background service runs)\n  profiles [--all | --profiles a,b]   choose which Hermes profiles to share\n  status | install-service | uninstall-service | unpair\n\nConfig: ${configFile()}`); return;
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
    if (cmd === 'agent-note') {
      const root = hermesRoot({ override: cfg.hermesHome }), sub = args._[1] ?? 'status', gw = gatewayCommand(root, cfg, process.env, []);
      if (sub === 'show') { const f = discoverProfiles(root)[0]; log(profileNote(cfg, root, f?.home).text); return; }
      if (sub === 'install') { for (const l of await installNotes(cfg, { root, yes: Boolean(args.yes), gw })) log(l); return; }
      if (sub === 'remove') { for (const l of removeNotes(cfg, { root })) log(l); return; }
      if (sub === 'status') { const rows = noteDoctor(cfg, { root, support: hermesNoteSupport(gw) }); for (const c of rows) log(`${c.status === 'ok' ? '[ok]  ' : '[warn]'} ${c.message}${c.fix ? `\n        fix: ${c.fix}` : ''}`); if (args.json) log(JSON.stringify(rows)); return; }
      throw new Error('Usage: agent-note [status|show|install [--yes]|remove]');
    }
    if (cmd === 'doctor') { // checks for this machine's side: Hermes profiles and the native gateway
      const droot = hermesRoot({ override: cfg?.hermesHome }), dgw = gatewayCommand(droot, cfg ?? {}, process.env, []);
      if (args.fix) for (const l of await installNotes(cfg, { root: droot, yes: Boolean(args.yes), gw: dgw, explicit: false })) log(l);
      const checks = [...await nativeDoctor(cfg ?? {}), ...mediaDoctor(cfg ?? {}, { root: droot }), ...noteDoctor(loadConfig() ?? cfg, { root: droot, support: hermesNoteSupport(dgw) })]; for (const c of checks) log(`${c.status === 'ok' ? '[ok]  ' : c.status === 'warn' ? '[warn]' : '[FAIL]'} ${c.id}: ${c.message}${c.fix ? `\n        fix: ${c.fix}` : ''}`);
      if (args.json) log(JSON.stringify(checks)); if (checks.some((c) => c.status === 'fail')) process.exit(1); return;
    }
    if (cmd === 'allow-media') { const dir = args._?.[1] ?? args.dir ?? process.argv[3]; if (!cfg) throw new Error('This computer is not paired yet. Run: foxfleet connector pair --hub URL --code CODE'); const next = allowMediaRoot(cfg, dir); saveConfig(next); log(`Shared with the hub: ${next.mediaRoots.at(-1)}\nAgents can now send files from there (a running connector picks this up on the next request).`); return; }
    if (cmd === 'status') { const root = hermesRoot({ override: cfg.hermesHome }); log(`Machine: ${cfg.name}\nHub: ${cfg.hub}\nConfig: ${configFile()} (0600)`); summary(root, discoverProfiles(root), cfg); return; }
    if (cmd === 'install-service') { installService(); return; }
    if (cmd === 'uninstall-service') { uninstallService(); return; }
    if (cmd === 'unpair') { uninstallService(); fs.rmSync(configFile(), { force: true }); log('Unpaired and removed the local token. Remove the machine in the app too (Manage > Machines) so its agents disappear.'); return; }
    throw new Error(`Unknown command "${cmd}". Run with "help".`);
  } catch (e) { console.error(e.message || String(e)); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
