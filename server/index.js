// Foxfleet relay: secrets stay server-side; importing never opens a listener.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { configStore, publicConnection, fault, identifier, validHost, secretsOf, connection as validateConnection, kindSpecs, capabilitiesOf, isChatKind, CHAT_KINDS } from './config.js';
import { hermesClient, upstreamJson, boundedBytes, safeAgentData } from './hermes.js';
import { artifactRegistry } from './artifacts.js';
import { scanAvatarPacks } from './avatars.js';
import { screenRelay } from './screen.js';
import { inboxStore } from './inbox.js';
import { mcpHandler, bearer } from './mcp.js';
import { runRegistry } from './runs.js';
import { coordinator } from './coordinator.js';
import { nativeFeatures, busyModes, nativeRun, nativeControl } from './hermes-runs.js';
import { nativeHub } from './hermes-ui.js';
import { nativeFacade, viewOf } from './native-facade.js';
import { catalogFor } from './commands.js';
import { historyStore, newSessionId, validSessionId } from './history.js';
import { normalizeTranscript, sessionRow, flattenContent } from './transcript.js';
import { openaiClient } from './openai.js';
import { readFileSync } from 'node:fs';
import { accountStore, SESSION_AGE as ACCOUNT_SESSION_AGE } from './accounts.js';
import { connectorHub } from './connector.js';
import { machineStore, normalizeCode, validCode, formatCode } from './machines.js';
import { wsAccept } from './ws.js';
import { qrSvg, qrRows } from './qr.js';
import { fetchImage } from './media-proxy.js';
import { TERMS_VERSION, acceptedTerms } from './legal.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';

const CHAT_KINDS_LIST = CHAT_KINDS;
const DIR = path.dirname(fileURLToPath(import.meta.url)), WEB_DIR = path.resolve(process.env.FOXFLEET_WEB_DIR || path.join(DIR, '..', 'web', 'dist'));
// Strict CSP for the web app: same-origin scripts only (Vite emits no inline script), inline style attributes allowed for layout.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4', '.map': 'application/json' };
const DEFAULT_AVATAR_DIR = path.join(WEB_DIR, 'avatars');
// Body limits (see docs/UPLOAD-LIMITS.md). JSON is buffered, so it stays small; files stream.
//  - JSON default 4 MiB (unchanged). Chat 10 MiB = the Hermes API server's own MAX_REQUEST_BYTES.
//  - Files 90 MiB, streamed straight into the dashboard's chunked upload (constant hub memory):
//    under Cloudflare's 100 MB request cap (Free/Pro) with room for multipart framing, and
//    under Hermes' 100 MiB managed-file cap.
export const LIMITS = { json: 4 * 1024 * 1024, chat: 10 * 1024 * 1024, transcribe: 12 * 1024 * 1024, file: 90 * 1024 * 1024 };
const BODY_LIMIT = LIMITS.json, SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
export const APP_ORIGIN = 'https://appassets.androidplatform.net';
const FILE_UNAVAILABLE = 'Agent file download unavailable; check Hermes version and session file permissions';
const loopback = (host) => ['localhost', '127.0.0.1', '::1'].includes(host);
const digest = (value) => createHash('sha256').update(value).digest();
function trustedOriginList(value) {
  const list = typeof value === 'string' ? value.trim() ? value.split(',').map((item) => item.trim()) : [] : value;
  if (!Array.isArray(list) || list.length > 16) throw fault(400, 'Invalid trusted origins; configure at most 16 HTTP(S) origins');
  return new Set(list.map((item) => {
    if (typeof item !== 'string' || item.length > 2048) throw fault(400, 'Invalid trusted origins');
    const text = item.trim(); let url;
    try { url = new URL(text); } catch { throw fault(400, 'Invalid trusted origins'); }
    if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(text) || /[\x00-\x20\x7f@*]/.test(text) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !validHost(url.hostname.replace(/^\[|\]$/g, '')) || url.port === '0') throw fault(400, 'Invalid trusted origins; use HTTP(S) origins without credentials, paths or wildcards');
    return url.origin;
  }));
}
function sendJson(res, status, data, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(JSON.stringify(data));
}
async function readJson(req, limit = BODY_LIMIT, allowArray = false) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw fault(413, 'Request body too large'); }
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) { req.resume(); throw fault(413, 'Request body too large'); } chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || (Array.isArray(value) && !allowArray) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw fault(400, 'Invalid JSON body'); }
}
const pageInt = (v, lo, hi, d) => { const n = Number(v ?? d); return Number.isInteger(n) ? Math.min(Math.max(n, lo), hi) : d; };
function sessionId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw fault(400, 'Invalid session ID'); return value; }
async function serveStatic(url, res, avatarBase = DEFAULT_AVATAR_DIR) {
  let name; try { name = decodeURIComponent(url.pathname); } catch { throw fault(400, 'Invalid path'); }
  if (name === '/') name = '/index.html';
  const isAvatar = name.startsWith('/avatars/');
  const root = isAvatar ? avatarBase : WEB_DIR;
  const relative_name = isAvatar ? name.slice('/avatars'.length) : name;
  const target = path.resolve(root, '.' + relative_name), relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || name.includes('\\') || name.includes('\0')) throw fault(403, 'Forbidden');
  const send = async (file, spa) => {
    const data = await readFile(file), ext = path.extname(file);
    const html = ext === '.html';
    // Hashed build output is immutable; the shell, service worker and manifest always revalidate (a deploy must be seen at once).
    const hashed = !isAvatar && /^\/assets\//.test(name) && /-[A-Za-z0-9_-]{8,}\./.test(path.basename(file));
    const cache = hashed ? 'public, max-age=31536000, immutable' : (html || ['.js', '.webmanifest'].includes(ext)) && !isAvatar ? 'no-cache' : 'public, max-age=300';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': cache, ...(html ? { 'Content-Security-Policy': CSP, 'Permissions-Policy': 'microphone=(self), camera=()', 'X-Frame-Options': 'DENY' } : {}) }); res.end(data);
  };
  try { return await send(target, false); } catch {}
  // SPA fallback: extension-less paths (client routes) get the app shell; missing files stay 404.
  if (!isAvatar && !path.extname(url.pathname)) { try { return await send(path.join(WEB_DIR, 'index.html'), true); } catch { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('The web app is not built. Run "npm run build" in web/ (or use the Docker image).'); } }
  sendJson(res, 404, { error: 'Not found' });
}
function chatBody(data) {
  if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 2000 || !data.messages.every((m) => m && ['user', 'assistant', 'system', 'tool', 'function'].includes(m.role) && (typeof m.content === 'string' || Array.isArray(m.content) || m.content === null))) throw fault(400, 'Invalid chat messages');
  if (data.model !== undefined && (typeof data.model !== 'string' || data.model.length > 200 || /[\x00-\x1f]/.test(data.model))) throw fault(400, 'Invalid model');
  if (data.session_id !== undefined) sessionId(data.session_id);
  return { model: data.model || 'hermes-agent', messages: data.messages, stream: true };
}
const safeFileName = (value) => {
  const base = String(value || '').split(/[\\/]/).pop().normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').replace(/[^\p{L}\p{N} ._()+-]/gu, '_').replace(/^\.+/, '').slice(-120).trim();
  return base || 'file';
};
const sse = (res, text, headers = {}) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\ndata: [DONE]\n\n`);
};
// Bundled Hermes slash-command catalog (generated from hermes-agent's COMMAND_REGISTRY by design/tools/gen-hermes-commands.py).
const HERMES_COMMANDS = JSON.parse(readFileSync(new URL('./hermes-commands.json', import.meta.url), 'utf8'));
const scopeOf = (ctx) => ctx?.auth?.user?.id ?? 'local';
async function streamResponse(req, res, getResponse, timeoutMs, headers, failureMessage = 'Agent request failed') {
  const abort = new AbortController(), onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', onClose);
  const timer = setTimeout(() => abort.abort(), timeoutMs); timer.unref();
  try {
    const upstream = await getResponse(abort.signal); clearTimeout(timer);
    if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); throw fault([403, 404, 405, 409, 413, 416].includes(upstream.status) ? upstream.status : 502, failureMessage); }
    if (res.destroyed) { await upstream.body.cancel(); return; }
    res.writeHead(upstream.status, headers(upstream));
    await pipeline(Readable.fromWeb(upstream.body), res, { signal: abort.signal });
  } finally { clearTimeout(timer); res.removeListener('close', onClose); abort.abort(); }
}

export async function createHub({ configPath = process.env.FOXFLEET_CONFIG || path.join(DIR, 'config.json'), host = process.env.FOXFLEET_HOST || '127.0.0.1', ownerPassword = process.env.FOXFLEET_PASSWORD || '', singleUser = false, trustedOrigins = process.env.FOXFLEET_TRUSTED_ORIGINS || '', timeoutMs = 5000, avatarDir } = {}) {
  if (!validHost(host)) throw fault(400, 'Invalid bind host');
  if (typeof ownerPassword !== 'string' || ownerPassword.length > 4096) throw fault(400, 'Invalid owner password');
  if (singleUser && !loopback(host)) throw fault(400, 'Single-user mode (no login) is only allowed on a loopback bind');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) throw fault(400, 'Invalid timeout');
  if (avatarDir !== undefined && (typeof avatarDir !== 'string' || !path.isAbsolute(avatarDir) || avatarDir.includes('\0'))) throw fault(400, 'Invalid avatar directory');
  const trusted = trustedOriginList(trustedOrigins);
  const trustedList = trusted, cfgPath = path.resolve(configPath), dataDir = path.dirname(cfgPath), avatarBase = avatarDir ? path.resolve(avatarDir) : DEFAULT_AVATAR_DIR;
  const accounts = await accountStore(path.join(dataDir, 'accounts'));
  // Legacy FOXFLEET_PASSWORD bootstraps the first owner ("owner") so existing deployments keep working.
  if (ownerPassword && accounts.needsSetup()) await accounts.createUser('owner', ownerPassword, 'owner', { skipPolicy: true });
  const setupCode = accounts.needsSetup() && !loopback(host) ? (process.env.FOXFLEET_SETUP_CODE || randomBytes(9).toString('base64url')) : '';
  const machines = await machineStore(path.join(dataDir, 'machines.json'));
  const runs = runRegistry(), facade = nativeFacade({ runs }), connectors = connectorHub(), openai = openaiClient(timeoutMs), als = new AsyncLocalStorage(), registries = new Map(), authFails = new Map();
  // Per-user registry: own agents, secrets, inbox, upstream caches and screen tickets. Handlers reach it through these scoped views.
  function registryFor(userId, owner) {
    if (!registries.has(userId)) registries.set(userId, (async () => {
      const dir = owner ? dataDir : path.join(dataDir, 'users', userId); await mkdir(dir, { recursive: true });
      const up = hermesClient(timeoutMs), reg = { history: await historyStore(path.join(dir, 'history.json')), store: await configStore(owner ? cfgPath : path.join(dir, 'config.json')), upstream: up, artifacts: artifactRegistry(), screens: screenRelay(up), inbox: await inboxStore(path.join(dir, 'inbox.json')) };
      reg.mcp = mcpHandler(reg.inbox); reg.coord = await coordinator(path.join(dir, 'queue.json'), { runs, stopWaitMs: Number(process.env.FOXFLEET_STOP_WAIT_MS) || 15_000 }); reg.native = await nativeHub({ connectors, file: path.join(dir, 'native-journal.json') }); facade.attachHooks(reg.native); return reg;
    })());
    return registries.get(userId);
  }
  const scoped = (key) => new Proxy({}, { get: (_, prop) => { const t = als.getStore()?.reg?.[key]; if (!t) throw fault(401, 'Login required'); const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v; } });
  const store = scoped('store'), upstream = scoped('upstream'), artifacts = scoped('artifacts'), screens = scoped('screens'), inbox = scoped('inbox'), history = scoped('history'), mcp = (...a) => als.getStore().reg.mcp(...a);
  const allRegistries = async () => singleUser ? [await registryFor('local', true)] : Promise.all(accounts.users().map((u) => registryFor(u.id, u.role === 'owner')));
  await allRegistries(); // fail fast on unreadable saved config
  const secureRequest = (req) => req.headers['x-forwarded-proto'] === 'https' || trusted.has(`https://${req.headers.host}`);
  const kindOf = (m) => m.kind || 'hermes';
  const mcpHits = new Map();
  async function inboxAgent(req) {
    const hash = createHash('sha256').update(bearer(req)).digest('hex');
    for (const reg of await allRegistries()) {
      const agent = reg.store.all().find((m) => m.kind === 'mcp-inbox' && m.inboxTokenHash.length === hash.length && timingSafeEqual(Buffer.from(m.inboxTokenHash), Buffer.from(hash)));
      if (!agent) continue;
      const now = Date.now(), key = createHash('sha1').update(hash).digest('hex'), hit = mcpHits.get(key) || { count: 0, until: now + 60000 };
      if (hit.until < now) { hit.count = 0; hit.until = now + 60000; }
      if (++hit.count > 120) throw fault(429, 'Too many requests');
      mcpHits.set(key, hit); return { agent, reg };
    }
    throw fault(401, 'Invalid token');
  }
  const hubOrigin = (req) => `${secureRequest(req) ? 'https' : 'http'}://${req.headers.host}`;
  // ---- machines (one connector per computer) ----
  const safeOrigin = (req) => { const o = hubOrigin(req); if (!/^https?:\/\/[A-Za-z0-9.\-:\[\]]{1,200}$/.test(o)) throw fault(400, 'Unusable host header'); return o; };
  const installScript = (origin, code, ps) => ps
    ? `# Foxfleet connector installer (PowerShell). Needs Node.js 22+.\n$ErrorActionPreference = 'Stop'\n$Hub = '${origin}'; $Code = '${code}'\nif (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Foxfleet needs Node.js 22 or newer: https://nodejs.org' }\nif ([int](node -p "process.versions.node.split('.')[0]") -lt 22) { throw "Node 22+ required (found $(node -v))" }\n$Dir = Join-Path $env:USERPROFILE '.foxfleet\\connector'; New-Item -ItemType Directory -Force $Dir | Out-Null\nInvoke-WebRequest "$Hub/connector.mjs" -OutFile (Join-Path $Dir 'foxfleet-connector.mjs')\nnode (Join-Path $Dir 'foxfleet-connector.mjs') pair --hub $Hub --code $Code\n`
    : `#!/bin/sh\n# Foxfleet connector installer, served by your hub. Needs Node.js 22+ and curl or wget.\n# It downloads the connector to ~/.foxfleet/connector and pairs this machine with the one-time code below.\nset -eu\nHUB='${origin}'\nCODE='${code}'\ncommand -v node >/dev/null 2>&1 || { echo "Foxfleet needs Node.js 22 or newer: https://nodejs.org" >&2; exit 1; }\nnode -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' || { echo "Node 22 or newer is required (found $(node -v))" >&2; exit 1; }\nDIR="\${FOXFLEET_HOME:-$HOME/.foxfleet}/connector"\nmkdir -p "$DIR"\nif command -v curl >/dev/null 2>&1; then curl -fsSL "$HUB/connector.mjs" -o "$DIR/foxfleet-connector.mjs"; else wget -qO "$DIR/foxfleet-connector.mjs" "$HUB/connector.mjs"; fi\nif [ -t 1 ] && [ -r /dev/tty ]; then exec node "$DIR/foxfleet-connector.mjs" pair --hub "$HUB" --code "$CODE" </dev/tty; fi\necho "No terminal available: exposing every Hermes profile found. Change later with: node $DIR/foxfleet-connector.mjs profiles"\nexec node "$DIR/foxfleet-connector.mjs" pair --hub "$HUB" --code "$CODE" --all\n`;
  function pairingView(req, made) {
    const hub = safeOrigin(req), url = `${hub}/c/${made.code}`, link = `foxfleet://pair?hub=${encodeURIComponent(hub)}&code=${made.code}`;
    let rows = null; try { rows = qrRows(url); } catch { /* link too long for the built-in QR: clients show the link only */ }
    return { code: made.code, display: made.display, expires: made.expires, url, link, rows,
      commands: { sh: `curl -fsSL ${url} | sh`, powershell: `irm ${url}.ps1 | iex`, node: `curl -fsSL ${hub}/connector.mjs -o foxfleet-connector.mjs && node foxfleet-connector.mjs pair --hub ${hub} --code ${made.code}` } };
  }
  const ownerOf = (userId) => singleUser ? { id: 'local', role: 'owner' } : accounts.users().find((u) => u.id === userId);
  const uniqueName = (reg, base, machineId) => { const taken = new Set(reg.store.all().filter((a) => a.machineId !== machineId || a.profile !== base).map((a) => a.name)); let n = base, i = 2; while (taken.has(n)) n = `${base}-${i++}`; return n; };
  // The connector tells the hub which profiles it exposes; each becomes (or stays) an agent in the owner's registry.
  async function syncProfiles(machine, msg, link) {
    const user = ownerOf(machine.userId); if (!user) throw fault(403, 'Owner is gone');
    const reg = await registryFor(user.id, user.role === 'owner');
    const names = [...new Set((Array.isArray(msg.profiles) ? msg.profiles : []).map((p) => String(p?.profile ?? '')).filter((n) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n)))].slice(0, 32);
    const mine = reg.store.all().filter((a) => a.machineId === machine.id);
    for (const a of mine) if (!names.includes(a.profile)) { await reg.store.remove(a.name); reg.upstream.clear(); }
    const out = [];
    for (const profile of names) {
      let a = reg.store.all().find((x) => x.machineId === machine.id && x.profile === profile);
      if (!a) a = await reg.store.add({ kind: 'hermes', connection: 'machine', machineId: machine.id, profile, name: uniqueName(reg, profile, machine.id) });
      out.push({ profile, agent: a.name });
    }
    await link.expose(names); await machines.setProfiles(machine.id, out); reg.upstream.clear();
    return { agents: out };
  }
  const newInboxToken = () => { const value = randomBytes(32).toString('base64url'); return { value, hash: createHash('sha256').update(value).digest('hex') }; };
  // The only agent shape clients get: no host, port, URL, profile path or upstream version strings.
  // Negotiation order: native UI gateway (through the machine connector) > HTTP /v1/runs > /v1/chat/completions.
  const nativeUi = (m) => Boolean(kindOf(m) === 'hermes' && m.machineId && connectors.ui(m.machineId)?.caps(m.profile)?.native);
  function agentView(m, p, index) {
    const online = Boolean(p.online), chatReady = Boolean(p.chatReady);
    return { id: m.name, name: m.name, displayName: m.label || m.name, kind: kindOf(m), order: index,
      description: m.description || '', avatar: m.avatar || null,
      status: chatReady ? 'ready' : online ? 'online' : 'offline', online, chatReady, managementReady: Boolean(p.managementReady),
      capabilities: { ...capabilitiesOf(m), busy: nativeUi(m) ? ['queue', 'steer', 'interrupt'] : busyModes({ kind: kindOf(m), native: p.capabilities ? nativeFeatures(p.capabilities) : null }), nativeUi: nativeUi(m), nativeRuns: Boolean(p.capabilities && nativeFeatures(p.capabilities).runs) },
      ...(Number.isInteger(p.active_sessions) ? { activeSessions: p.active_sessions } : {}),
      ...(p.lastSeen !== undefined ? { lastSeen: p.lastSeen } : {}),
      checks: Object.fromEntries(Object.entries(p.checks || {}).map(([k, c]) => [k, { ok: Boolean(c?.ok), message: String(c?.message ?? '') }])) };
  }
  function probeAny(m) {
    if (isChatKind(kindOf(m))) return openai.probe(m);
    if (kindOf(m) === 'mcp-inbox') { const seen = inbox.lastSeen(m.name); return Promise.resolve({ name: m.name, kind: 'mcp-inbox', label: m.label, online: seen > Date.now() - 24 * 3600 * 1000, chatReady: true, managementReady: false, lastSeen: seen ? new Date(seen).toISOString() : null, checks: { inbox: { ok: true, message: seen ? 'Agent checked in' : 'Waiting for the agent to connect' } }, capabilities: { object: 'foxfleet.bridge', features: { chat_completions: true, mailbox: true, images: false, files: false, screen: false, sessions: true } } }); }
    if (m.machineId && !connectors.isOnline(m.machineId)) return Promise.resolve({ name: m.name, kind: 'hermes', label: m.label, online: false, chatReady: false, managementReady: false, checks: { connector: { ok: false, message: 'Waiting for the machine to connect' } } });
    return upstream.probe(m).then((a) => ({ kind: 'hermes', ...a, ...(m.machineId ? { checks: { connector: { ok: true, message: 'Machine online' }, ...a.checks } } : {}) }));
  }
  function current(m) { if (!store.isCurrent(m)) throw fault(409, 'Connection changed; retry the request'); }
  // Which native run controls this Hermes profile advertises (GET /v1/capabilities), cached briefly. Chat kinds have none.
  const nativeCache = new Map();
  async function nativeFor(m) {
    if (kindOf(m) !== 'hermes') return null;
    const k = JSON.stringify([m.name, m.profile, m.machineId]), hit = nativeCache.get(k); if (hit && Date.now() - hit.at < 30_000) return hit.native;
    let native = { runs: false, steer: false, stop: false, status: false };
    try { const r = await upstream.api(m, '/v1/capabilities'); if (r.ok) { const d = await r.json(); if (d?.object === 'hermes.api_server.capabilities' && d.features && typeof d.features === 'object') native = nativeFeatures({ features: d.features }); } else await r.body?.cancel(); } catch { /* older Hermes or unreachable: no native controls */ }
    nativeCache.set(k, { at: Date.now(), native }); return native;
  }
  // How the coordinator starts a reply. It runs later (queue drain, interrupt), outside the request: use the captured registry, never the scoped proxies.
  function launcher(m, ctx, native) {
    const reg = ctx.reg, scope = scopeOf(ctx);
    return { async launch(item, { rebuild }) {
      const isChat = isChatKind(kindOf(m)), hist = reg.history;
      if (isChat) {
        const sid = validSessionId(item.session) ? item.session : newSessionId();
        let messages = item.body?.messages;
        if (rebuild || !messages) { const past = hist.messages(m.name, sid, { limit: 200, offset: 0 })?.messages ?? []; messages = [...past.filter((x) => x.role === 'user' || x.role === 'assistant').map((x) => ({ role: x.role, content: typeof x.content === 'string' ? x.content : x.text ?? '' })), item.message]; }
        return runs.start({ scope, agent: m.name, session: sid, open: (signal) => openai.chat(m, messages, signal), timeoutMs: Math.max(timeoutMs, 30000),
          check: (r) => { if (!r.headers.get('content-type')?.includes('text/event-stream')) throw fault(502, 'Invalid chat stream'); return { 'X-Hermes-Session-Id': sid }; },
          onFinish: (r, state) => { if (r.text && state !== 'error') void hist.append(m.name, sid, item.text, r.text); } });
      }
      const link = {};
      if (native?.runs) {
        const content = item.message.content, input = typeof content === 'string' ? content : [{ role: 'user', content }];
        const ctrl = nativeControl({ api: reg.upstream.api, m, link }); link.steer = ctrl.steer; link.stop = ctrl.stop;
        return runs.start({ scope, agent: m.name, session: item.session || undefined, link, timeoutMs, onFinish: undefined,
          open: (signal) => nativeRun({ api: (mm, route, o) => reg.upstream.api(mm, route, o), m, input, sessionId: item.session || undefined, idempotencyKey: item.id, link, signal }),
          check: (r) => ({ ...(r.headers.get('x-hermes-session-id') ? { 'X-Hermes-Session-Id': r.headers.get('x-hermes-session-id') } : {}) }) });
      }
      const messages = rebuild || !item.body ? [item.message] : item.body.messages; // older Hermes keeps its own transcript by session id
      return runs.start({ scope, agent: m.name, session: item.session || undefined, timeoutMs,
        open: (signal) => reg.upstream.api(m, '/v1/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(item.session ? { 'X-Hermes-Session-Id': item.session } : {}) }, body: JSON.stringify({ model: item.body?.model || 'hermes-agent', messages, stream: true }) }),
        check: (r) => { if (!r.headers.get('content-type')?.includes('text/event-stream')) throw fault(502, 'Invalid chat stream'); return { ...(r.headers.get('x-hermes-session-id') ? { 'X-Hermes-Session-Id': r.headers.get('x-hermes-session-id') } : {}) }; } });
    } };
  }
  function agentData(m, route, data, originalConnections) { current(m); const safe = safeAgentData(data, [...originalConnections, ...store.all()]); return route === 'skills' && Array.isArray(safe) ? { skills: safe } : safe; }
  const cookieToken = (req) => req.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith('foxfleet_session='))?.slice('foxfleet_session='.length);
  const bearerToken = (req) => /^Bearer (\S{1,200})$/i.exec(req.headers.authorization || '')?.[1];
  const cookieFor = (req, value, maxAge = ACCOUNT_SESSION_AGE / 1000) => `foxfleet_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(req) ? '; Secure' : ''}`;
  // Resolve the caller: { user, device, via, rotated? } or null. Bearer (app) wins over cookie (web).
  async function identify(req) {
    if (singleUser) return { user: { id: 'local', username: 'local', role: 'owner' }, device: 'local', via: 'single' };
    const b = bearerToken(req), c = cookieToken(req), token = b || c;
    const found = token ? await accounts.authenticate(token) : null;
    return found ? { ...found, via: b ? 'bearer' : 'cookie' } : null;
  }
  const clientIp = (req) => req.socket.remoteAddress || '';
  function authThrottle(req) { const ip = clientIp(req), now = Date.now(), a = authFails.get(ip) || { count: 0, until: now + 60000 }; if (a.until < now) { a.count = 0; a.until = now + 60000; } if (++a.count > 60) throw fault(429, 'Too many requests'); authFails.set(ip, a); if (authFails.size > 5000) authFails.clear(); }
  const sessionReply = (req, res, auth, user, client, deviceId, token) => sendJson(res, 200, { authenticated: true, user, deviceId, ...(client === 'app' ? { token } : {}) }, client === 'app' ? {} : { 'Set-Cookie': cookieFor(req, token) });
  function boundary(req, server) {
    if (typeof req.headers.host !== 'string' || /[\s\/\\@?#]/.test(req.headers.host)) throw fault(403, 'Untrusted host');
    let authority; try { authority = new URL('http://' + req.headers.host); } catch { throw fault(403, 'Untrusted host'); }
    const address = req.socket.localAddress?.replace(/^::ffff:/, ''), allowed = new Set([host, address]);
    if (loopback(address)) { allowed.add('localhost'); allowed.add('127.0.0.1'); allowed.add('::1'); }
    const requestOrigins = new Set();
    if (allowed.has(authority.hostname.replace(/^\[|\]$/g, '')) && Number(authority.port || 80) === server.address()?.port) requestOrigins.add(authority.origin);
    // Only explicit origins may account for a published port or HTTPS proxy.
    // Forwarded headers never expand the authority or scheme trusted here.
    for (const scheme of ['http', 'https']) {
      const candidate = new URL(`${scheme}://${req.headers.host}`).origin;
      if (trusted.has(candidate)) requestOrigins.add(candidate);
    }
    if (!requestOrigins.size) throw fault(403, 'Untrusted host');
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fault(403, 'Cross-origin request rejected');
      if (req.headers.origin && !requestOrigins.has(req.headers.origin)) throw fault(403, 'Cross-origin request rejected');
      const mime = req.headers['content-type'], hasBody = Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'];
      const upload = req.method === 'POST' && /^\/api\/agents\/[^/]+\/files$/.test(req.url.split('?')[0]) && /^application\/octet-stream$/i.test(mime || '');
      if (!upload && (mime || hasBody) && !/^application\/json(?:\s*;|$)/i.test(mime || '')) { req.resume(); throw fault(415, 'Mutations require application/json'); }
    }
  }
  const server = http.createServer((req, res) => als.run({}, async () => {
    const ctx = als.getStore();
    try {
      boundary(req, server);
      const url = new URL(req.url, 'http://hub');
      let parts; try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw fault(400, 'Invalid path'); }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/connector.mjs') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(await readFile(path.join(DIR, '..', 'connector', 'foxfleet-connector.mjs'))); }
      if (req.method === 'GET' && url.pathname === '/connect-agent.md') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); return res.end(await readFile(path.join(DIR, '..', 'docs', 'CONNECT-AGENT.md'))); }
      { // one-line installer for a machine: GET /c/<code> (sh) or /c/<code>.ps1 (PowerShell). Reading it does NOT use the code up.
        const m = req.method === 'GET' && /^\/c\/([A-Za-z0-9-]{10,12})(\.ps1)?$/.exec(url.pathname);
        if (m) {
          authThrottle(req); const code = normalizeCode(m[1]);
          if (!validCode(code)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('That pairing link is not valid.\n'); }
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(installScript(safeOrigin(req), code, Boolean(m[2])));
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/machines/redeem') { // the connector exchanges a pairing code for its machine token (once)
        authThrottle(req); const b = await readJson(req, 4096);
        try { const r = await machines.redeem(b.code, { name: b.name, os: b.os }, clientIp(req)); return sendJson(res, 200, { machineId: r.machineId, token: r.token, name: r.name, hub: safeOrigin(req) }); }
        catch (e) { if (e.retryAfter) { res.setHeader('Retry-After', String(e.retryAfter)); } throw e; }
      }
      const auth = await identify(req); ctx.auth = auth;
      if (req.method === 'GET' && url.pathname === '/pair') { // owner-only page with the pairing QR (web counterpart of the in-app Admin screen)
        if (!auth || auth.user.role !== 'owner') { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); return res.end(); }
        const hub = hubOrigin(req), link = `foxfleet://connect?hub=${hub}`; let svg = ''; try { svg = qrSvg(link); } catch {}
        const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
        return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair a phone</title><style>body{font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f3ee;color:#2b2723}main{max-width:380px;padding:24px;text-align:center}svg{width:260px;height:260px;border-radius:12px}code{word-break:break-all;font-size:13px}@media(prefers-color-scheme:dark){body{background:#14110f;color:#eee}}a{color:#d9622b}</style><main><h1>Pair a phone</h1><p>Open Foxfleet on your phone, tap <b>Scan QR</b> on the first screen, and point it here.</p>${svg || '<p>Address too long for a QR.</p>'}<p><code>${esc(link)}</code></p><p><a href="/">Back</a></p></main>`);
      }
      if (auth) { ctx.reg = await registryFor(auth.user.id, auth.user.role === 'owner'); if (auth.rotated) res.setHeader(auth.via === 'cookie' ? 'Set-Cookie' : 'X-Session-Token', auth.via === 'cookie' ? cookieFor(req, auth.rotated) : auth.rotated); }
      const originalConnections = auth ? store.all() : [];
      const body0 = () => readJson(req, 64 * 1024), deviceMeta = (b, client) => ({ name: typeof b.deviceName === 'string' && b.deviceName.trim() ? b.deviceName.trim() : client === 'app' ? 'Android app' : 'Web browser', kind: client, ip: clientIp(req), ua: req.headers['user-agent'] });
      const clientOf = (b) => b.client === 'app' ? 'app' : 'web';
      if (req.method === 'GET' && url.pathname === '/api/auth') return sendJson(res, 200, { required: !singleUser, setupRequired: !singleUser && accounts.needsSetup(), setupCodeRequired: Boolean(setupCode), registration: singleUser ? 'closed' : accounts.registration(), termsVersion: TERMS_VERSION, authenticated: Boolean(auth), ...(auth ? { user: auth.user, deviceId: auth.device } : {}) });
      if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
        authThrottle(req); const b = await body0();
        if (singleUser || !accounts.needsSetup()) throw fault(409, 'Setup is already complete');
        if (setupCode) { const given = Buffer.from(String(b.setupCode ?? '')), want = Buffer.from(setupCode); if (given.length !== want.length || !timingSafeEqual(given, want)) throw fault(403, 'Setup code is wrong'); }
        const user = await accounts.createUser(b.username, b.password, 'owner', { terms: acceptedTerms(b.acceptedTerms) }), { token, deviceId } = await accounts.createSession(user.id, deviceMeta(b, clientOf(b)));
        return sessionReply(req, res, null, user, clientOf(b), deviceId, token);
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        authThrottle(req); const b = await body0(); if (singleUser) throw fault(400, 'Login is not used in single-user mode');
        const user = await accounts.verify(b.username, b.password, clientIp(req)), { token, deviceId } = await accounts.createSession(user.id, deviceMeta(b, clientOf(b)));
        return sessionReply(req, res, null, user, clientOf(b), deviceId, token);
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        authThrottle(req); const b = await body0(); if (singleUser) throw fault(403, 'Registration is closed');
        const user = await accounts.register(b.username, b.password, b.invite, acceptedTerms(b.acceptedTerms)), { token, deviceId } = await accounts.createSession(user.id, deviceMeta(b, clientOf(b)));
        return sessionReply(req, res, null, user, clientOf(b), deviceId, token);
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        if (auth && !singleUser) await accounts.revoke(auth.user.id, auth.device).catch(() => {});
        return sendJson(res, 200, { authenticated: singleUser }, { 'Set-Cookie': cookieFor(req, '', 0) });
      }
      if (url.pathname === '/mcp') {
        // Bridged agents (Scribe) authenticate with their own per-agent bearer token, not a user session.
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' }); return res.end(); }
        const { agent, reg } = await inboxAgent(req); ctx.reg = reg;
        const body = await readJson(req, 256 * 1024, true), reply = mcp(agent, body);
        if (!reply) { res.writeHead(202, { 'Cache-Control': 'no-store' }); return res.end(); }
        return sendJson(res, 200, reply);
      }
      if (parts[0] === 'api' && !auth) throw fault(401, 'Login required');
      if (parts[0] === 'api' && parts[1] === 'auth') {
        const me = auth.user, route = parts[2];
        if (req.method === 'POST' && route === 'refresh' && !singleUser) { const fresh = await accounts.rotate(auth.device); return sendJson(res, 200, auth.via === 'cookie' ? { ok: true } : { token: fresh }, auth.via === 'cookie' ? { 'Set-Cookie': cookieFor(req, fresh) } : {}); }
        if (req.method === 'POST' && route === 'logout-all' && !singleUser) { await accounts.revokeAll(me.id); return sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': cookieFor(req, '', 0) }); }
        if (req.method === 'GET' && route === 'devices' && parts.length === 3) return sendJson(res, 200, { devices: singleUser ? [] : accounts.devices(me.id, auth.device) });
        if (req.method === 'DELETE' && route === 'devices' && parts.length === 4) { await accounts.revoke(me.id, parts[3]); return sendJson(res, 200, { ok: true, signedOut: parts[3] === auth.device }); }
        if (req.method === 'POST' && route === 'password' && !singleUser) { const b = await body0(); await accounts.changePassword(me.id, b.current, b.next, auth.device); return sendJson(res, 200, { ok: true }); }
        throw fault(404, 'Not found');
      }
      if (parts[0] === 'api' && parts[1] === 'admin') {
        if (auth.user.role !== 'owner') throw fault(403, 'Owner only');
        const route = parts[2];
        if (route === 'settings' && req.method === 'GET') return sendJson(res, 200, { registration: accounts.registration() });
        if (route === 'settings' && req.method === 'PUT') { await accounts.setRegistration((await body0()).registration, auth.user.id); return sendJson(res, 200, { registration: accounts.registration() }); }
        if (route === 'invites' && parts.length === 3 && req.method === 'GET') return sendJson(res, 200, { invites: accounts.invites() });
        if (route === 'pairing' && req.method === 'GET') { const hub = hubOrigin(req), link = `foxfleet://connect?hub=${hub}`; let svg = null; try { svg = qrSvg(link); } catch {} return sendJson(res, 200, { hub, link, svg, rows: qrRows(link) }); }
        if (route === 'invites' && parts.length === 3 && req.method === 'POST') { const b = await body0(), inv = await accounts.createInvite(auth.user.id, Number(b.ttlHours) || 72); const link = `foxfleet://connect?hub=${hubOrigin(req)}&invite=${inv.code}`; return sendJson(res, 201, { ...inv, link, rows: qrRows(link) }); }
        if (route === 'users' && parts.length === 4 && req.method === 'PATCH') return sendJson(res, 200, { user: await accounts.setDisabled(auth.user.id, parts[3], Boolean((await body0()).disabled)) });
        if (route === 'invites' && parts.length === 4 && req.method === 'DELETE') { await accounts.deleteInvite(parts[3]); return sendJson(res, 200, { ok: true }); }
        if (route === 'users' && parts.length === 3 && req.method === 'GET') return sendJson(res, 200, { users: accounts.users() });
        if (route === 'users' && parts.length === 4 && req.method === 'DELETE') { await accounts.removeUser(auth.user.id, parts[3]); return sendJson(res, 200, { ok: true }); }
        throw fault(404, 'Not found');
      }
      if (req.method === 'GET' && url.pathname === '/api/media-proxy') {
        const img = await fetchImage(url.searchParams.get('url'));
        res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.body.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin' });
        return res.end(img.body);
      }
      if (req.method === 'GET' && url.pathname === '/api/avatars') {
        // Rendered avatar packs are discovered at request time; a missing or empty directory is not an error.
        return sendJson(res, 200, { avatars: await scanAvatarPacks(avatarBase) });
      }
      if (url.pathname === '/api/connections') {
        if (req.method === 'GET') return sendJson(res, 200, { connections: store.all().map(publicConnection) });
        if (req.method === 'POST') {
          const data = await readJson(req), token = data?.kind === 'mcp-inbox' ? newInboxToken() : null;
          if (data?.connection === 'machine' || data?.machineId) throw fault(400, 'Machine agents are added by connecting a machine (Manage > Machines)');
          const m = await store.add(token ? { ...data, inboxTokenHash: token.hash } : data);
          // Tokens are shown once; only their hashes are stored.
          return sendJson(res, 201, { connection: publicConnection(m), ...(token ? { inboxToken: token.value, mcpUrl: '/mcp' } : {}) });
        }
      }
      if (parts[0] === 'api' && parts[1] === 'machines') {
        const uid = auth.user.id, view = (m) => machines.publicMachine(m, { online: connectors.isOnline(m.id), ...(connectors.lastSeen(m.id) ? { lastSeen: connectors.lastSeen(m.id) } : {}) });
        if (parts.length === 2 && req.method === 'GET') return sendJson(res, 200, { machines: machines.all(uid).map(view) });
        if (parts.length === 3 && parts[2] === 'pairing' && req.method === 'POST') { const b = await body0(); return sendJson(res, 201, pairingView(req, machines.createPairing(uid, { machineId: typeof b.machineId === 'string' ? b.machineId : undefined }))); }
        if (parts.length === 3 && parts[2] === 'pairing' && req.method === 'GET') { const st = machines.pairingStatus(uid, url.searchParams.get('code')); return sendJson(res, 200, { state: st.state, ...(st.expires ? { expires: st.expires } : {}), ...(st.machine ? { machine: view(machines.get(st.machine.id)) } : {}) }); }
        if (parts.length === 3 && req.method === 'PATCH') { const b = await body0(); return sendJson(res, 200, { machine: view(await machines.rename(uid, parts[2], b.name)) }); }
        if (parts.length === 3 && req.method === 'DELETE') { // revoke: token gone, link dropped, its agents removed
          const m = await machines.remove(uid, parts[2]); connectors.drop(m.id);
          for (const a of store.all().filter((x) => x.machineId === m.id)) { await store.remove(a.name); artifacts.clearAgent(a.name); }
          upstream.clear(); return sendJson(res, 200, { ok: true });
        }
        if (parts.length === 4 && parts[3] === 'token' && req.method === 'POST') { // rotate: the old token dies now; a new code re-pairs the same machine
          const m = await machines.invalidateToken(uid, parts[2]); connectors.drop(m.id); return sendJson(res, 201, pairingView(req, machines.createPairing(uid, { machineId: m.id })));
        }
        throw fault(404, 'Not found');
      }
      if (url.pathname === '/api/agent-kinds' && req.method === 'GET') return sendJson(res, 200, { kinds: kindSpecs() });
      if (url.pathname === '/api/connections/order' && req.method === 'POST') { const body = await readJson(req); await store.reorder(body?.names); return sendJson(res, 200, { order: store.all().map((m) => m.name) }); }
      if (url.pathname === '/api/connections/test' && req.method === 'POST') { // Probe a draft without saving; editing drafts inherit saved write-only fields.
        const data = await readJson(req); let prior; try { prior = data?.name ? store.get(data.name) : undefined; } catch {}
        if (prior && data.kind && kindOf(prior) !== data.kind) prior = undefined;
        const draft = validateConnection(data?.kind === 'mcp-inbox' && !prior ? { ...data, inboxTokenHash: '0'.repeat(64) } : data, prior);
        const result = await probeAny(draft);
        return sendJson(res, 200, { checks: agentView(draft, result, 0).checks, ok: Boolean(result.chatReady || result.online) });
      }
      if (parts[0] === 'api' && parts[1] === 'connections' && parts[2]) {
        if (parts.length === 3 && req.method === 'PUT') { const m = await store.edit(parts[2], await readJson(req)); upstream.clear(); artifacts.clearAgent(parts[2]); return sendJson(res, 200, { connection: publicConnection(m) }); }
        if (parts.length === 3 && req.method === 'DELETE') { if (store.get(parts[2]).machineId) throw fault(409, 'This agent comes from a connected machine. Change which profiles it shares with the connector (foxfleet-connector profiles) or remove the machine.'); await store.remove(parts[2]); inbox.drop(parts[2]); upstream.clear(); artifacts.clearAgent(parts[2]); return sendJson(res, 200, { ok: true }); }
        if (parts.length === 4 && parts[3] === 'token' && req.method === 'POST') {
          const prior = store.get(parts[2]);
          if (prior.kind !== 'mcp-inbox') throw fault(400, 'This agent has no token'); const t = newInboxToken(); const m = await store.edit(parts[2], { inboxTokenHash: t.hash }); return sendJson(res, 200, { connection: publicConnection(m), inboxToken: t.value, mcpUrl: '/mcp' });
        }
        if (parts.length === 4 && parts[3] === 'test' && req.method === 'POST') { const m = store.get(parts[2]), result = await probeAny(m); current(m); return sendJson(res, 200, { checks: agentView(m, result, 0).checks, capabilities: capabilitiesOf(m) }); }
      }
      if (url.pathname === '/api/history/settings' && ['GET', 'PUT'].includes(req.method)) { // how long the hub keeps chat history for API-key agents (this user only)
        if (req.method === 'PUT') { const b = await readJson(req, 1024); await history.setRetention(b.retentionDays); }
        return sendJson(res, 200, { retentionDays: history.retentionDays });
      }
      if (url.pathname === '/api/agents' && req.method === 'GET') { // Every kind, in registry order (?bridged=1 is accepted for 0.4 clients and ignored).
        const agents = await Promise.all(originalConnections.map(async (m, i) => agentView(m, await probeAny(m), i))); originalConnections.forEach(current); return sendJson(res, 200, { agents }); }
      if (parts[0] === 'api' && parts[1] === 'agents' && parts.length === 3 && req.method === 'GET') { const m = store.get(parts[2]); const view = agentView(m, await probeAny(m), originalConnections.indexOf(m)); current(m); return sendJson(res, 200, { agent: view }); }
      if (parts[0] === 'api' && parts[1] === 'agents' && parts[2]) {
        const m = store.get(parts[2]), route = parts[3];
        if (url.searchParams.has('profile') && url.searchParams.get('profile') !== m.profile) throw fault(400, 'Use the saved connection profile');
        if (route === 'native') { // native Hermes UI gateway (see hermes-ui.js): sessions, journaled sends, shared event stream, approvals/clarifications
          if (kindOf(m) !== 'hermes' || !nativeUi(m)) { if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, { native: false }); throw fault(409, 'This agent has no native Hermes gateway; use the standard chat'); }
          const nat = ctx.reg.native, scope = scopeOf(ctx), mid = m.machineId, prof = m.profile, sidOf = (v) => { if (!/^[\w.:-]{1,120}$/.test(v ?? '')) throw fault(400, 'Invalid session'); return v; };
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, nat.capabilities(mid, prof));
          if (parts.length === 5 && parts[4] === 'sessions' && req.method === 'POST') { await readJson(req); return sendJson(res, 201, await nat.create(scope, mid, prof)); }
          if (parts.length === 5 && parts[4] === 'busy') { // PROFILE-wide Hermes setting (display.busy_input_mode): read freely, change only on explicit confirmation
            if (req.method === 'GET') return sendJson(res, 200, { ...(await nat.busy(scope, mid, prof, 'status')), scope: 'profile' });
            if (req.method === 'POST') { const b = await readJson(req); if (b.confirm !== true) throw fault(400, 'This changes how every chat of this Hermes profile treats messages sent while it works; confirm to continue'); if (!['queue', 'steer', 'interrupt'].includes(b.mode)) throw fault(400, 'Invalid mode'); return sendJson(res, 200, { ...(await nat.busy(scope, mid, prof, b.mode)), scope: 'profile' }); }
          }
          if (parts.length === 5 && parts[4] === 'commands' && req.method === 'GET') { const r = await nat.ui(mid).call(prof, 'catalog'); return sendJson(res, 200, { source: 'agent', pairs: (r.pairs ?? []).slice(0, 500) }); }
          if (parts.length === 5 && parts[4] === 'models' && req.method === 'GET') { const r = await nat.ui(mid).call(prof, 'models', { refresh: url.searchParams.get('refresh') === '1' }); return sendJson(res, 200, { providers: (r.providers ?? []).map((pr) => ({ slug: String(pr.slug), name: String(pr.name ?? pr.slug), current: pr.is_current === true, models: (pr.models ?? []).map((x) => (typeof x === 'string' ? x : x?.id ?? x?.name)).filter(Boolean).slice(0, 300).map(String) })).slice(0, 60) }); }
          if (parts.length === 7 && parts[4] === 'sessions') {
            const sid = sidOf(parts[5]), what = parts[6];
            if (what === 'attach' && req.method === 'POST') { await readJson(req); return sendJson(res, 200, await nat.attach(scope, mid, prof, sid)); }
            if (what === 'messages' && req.method === 'POST') { const b = await readJson(req, LIMITS.chat); if (b.client_id !== undefined && !/^[\w.:-]{8,100}$/.test(String(b.client_id))) throw fault(400, 'Invalid client_id'); const r = await nat.send(scope, mid, prof, sid, { text: b.text, mode: typeof b.mode === 'string' ? b.mode : 'auto', clientId: b.client_id }); return sendJson(res, r.duplicate ? 200 : 202, r); }
            if (what === 'messages' && req.method === 'GET') return sendJson(res, 200, { messages: nat.list(scope, prof, sid) });
            if (what === 'interrupt' && req.method === 'POST') { await readJson(req); return sendJson(res, 200, await nat.interrupt(scope, mid, prof, sid)); }
            if (what === 'model' && req.method === 'POST') { const b = await readJson(req); return sendJson(res, 200, await nat.setModel(scope, mid, prof, sid, b.model)); }
            if (what === 'events' && req.method === 'GET') { // SSE: hub cursor, replay + live, any number of viewers
              const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0), n = Number.isInteger(after) && after > 0 ? after : 0;
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
              const write = (e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
              const f = nat.follow(scope, mid, prof, sid, n, write); if (f.truncated) res.write(`event: foxfleet.gap\ndata: ${JSON.stringify({ cursor: f.cursor })}\n\n`); for (const e of f.events) write(e);
              const ka = setInterval(() => res.write(': keep-alive\n\n'), 15_000); ka.unref?.(); res.once('close', () => { clearInterval(ka); f.unsubscribe(); }); return;
            }
          }
          if (parts.length === 8 && parts[4] === 'sessions' && parts[6] === 'requests' && req.method === 'POST') { const b = await readJson(req); return sendJson(res, 200, await nat.respond(scope, mid, prof, sidOf(parts[5]), parts[7], { result: b.result, error: b.error })); }
          throw fault(404, 'Not found');
        }
        if (route === 'commands' && parts.length === 4 && req.method === 'GET') { // per-agent catalog: Hermes' full list (bundled; Hermes has no REST endpoint for its live registry) marked with what THIS agent can run
          const native = await nativeFor(m), modes = nativeUi(m) ? ['queue', 'steer', 'interrupt'] : busyModes({ kind: kindOf(m), native });
          return sendJson(res, 200, { source: kindOf(m) === 'hermes' ? 'bundled' : 'local', busy: modes, ...(nativeUi(m) ? { native: true } : {}), commands: catalogFor({ kind: kindOf(m), bundled: HERMES_COMMANDS.commands, modes }) });
        }
        if (route === 'queue' && nativeUi(m)) { // native sessions: Hermes holds the queue; the hub only reports what it was told and what Hermes still has
          const session = url.searchParams.get('session_id') || '';
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, await facade.queue(ctx.reg.native, { scope: scopeOf(ctx), m, session }));
          if (parts.length === 5 && parts[4] === 'resume' && req.method === 'POST') { await readJson(req); return sendJson(res, 200, await facade.queue(ctx.reg.native, { scope: scopeOf(ctx), m, session })); }
          if (parts.length === 5 && req.method === 'DELETE') throw fault(409, 'Hermes owns this queue: a queued message cannot be taken back from here');
          throw fault(404, 'Not found');
        }
        if (route === 'queue' && ['hermes', ...CHAT_KINDS_LIST].includes(kindOf(m))) { // the hub-side message queue of one conversation
          const scope = scopeOf(ctx), session = url.searchParams.get('session_id') || '', native = await nativeFor(m), modes = busyModes({ kind: kindOf(m), native });
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, { ...ctx.reg.coord.list(scope, m.name, session), modes });
          if (parts.length === 5 && parts[4] === 'resume' && req.method === 'POST') { await readJson(req); return sendJson(res, 200, { ...(await ctx.reg.coord.resume(launcher(m, ctx, native), scope, m.name, session)), modes }); }
          if (parts.length === 5 && req.method === 'DELETE') return sendJson(res, 200, { message: await ctx.reg.coord.cancel(scope, m.name, session, parts[4]) });
          throw fault(404, 'Not found');
        }
        if (route === 'messages' && parts.length === 4 && req.method === 'POST' && nativeUi(m)) {
          const data = await readJson(req, LIMITS.chat), payload = chatBody(data); current(m);
          const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'); if (!lastUser) throw fault(400, 'No user message');
          const flat = flattenContent(lastUser.content), text = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
          if (data.client_id !== undefined && !/^[\w.:-]{8,100}$/.test(String(data.client_id))) throw fault(400, 'Invalid client_id');
          const r = await facade.send(ctx.reg.native, { scope: scopeOf(ctx), m, session: data.session_id, text, mode: typeof data.mode === 'string' ? data.mode : 'queue', clientId: data.client_id });
          return sendJson(res, r.duplicate ? 200 : 202, { message: viewOf(r.message), session_id: r.stored, ...(r.run ? { run_id: r.run.id } : {}) });
        }
        if (route === 'messages' && parts.length === 4 && req.method === 'POST' && ['hermes', ...CHAT_KINDS_LIST].includes(kindOf(m))) {
          // Send while the agent may be busy. Persisted + acknowledged first; follow the reply through /runs/{id}/events.
          const data = await readJson(req, LIMITS.chat), payload = chatBody(data); current(m);
          const native = await nativeFor(m), modes = busyModes({ kind: kindOf(m), native });
          const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'); if (!lastUser) throw fault(400, 'No user message');
          const flat = flattenContent(lastUser.content), text = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
          const mode = typeof data.mode === 'string' ? data.mode : 'queue';
          if (data.client_id !== undefined && !/^[\w.:-]{8,100}$/.test(String(data.client_id))) throw fault(400, 'Invalid client_id');
          const result = await ctx.reg.coord.submit(launcher(m, ctx, native), { scope: scopeOf(ctx), agent: m.name, session: validSessionId(data.session_id) ? data.session_id : '', mode, text, message: { role: 'user', content: lastUser.content }, body: payload, clientId: data.client_id, modes });
          return sendJson(res, result.duplicate ? 200 : 202, result);
        }
        if (route === 'runs') { // resumable chat runs: list, follow from a cursor, stop. A run outlives its client connection.
          const scope = scopeOf(ctx);
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, { runs: runs.list(scope, m.name, url.searchParams.get('session_id') || undefined) });
          if (parts.length === 6 && parts[5] === 'events' && req.method === 'GET') { const r = runs.get(scope, m.name, parts[4]), after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0); return runs.attach(req, res, r, Number.isInteger(after) && after > 0 ? after : 0); }
          if (parts.length === 6 && parts[5] === 'stop' && req.method === 'POST') { await readJson(req); const r = runs.get(scope, m.name, parts[4]); const confirmed = await ctx.reg.coord.stop(scope, m.name, r.session || '', r); return sendJson(res, 200, { run: runs.view(r), confirmed }); }
          throw fault(404, 'Not found');
        }
        if (isChatKind(kindOf(m))) {
          if (route === 'chat' && parts.length === 4 && req.method === 'POST') {
            const data = await readJson(req, LIMITS.chat), payload = chatBody(data); current(m);
            const sid = validSessionId(data.session_id) ? data.session_id : newSessionId(), hist = ctx.reg.history;
            const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'), flat = flattenContent(lastUser?.content), userText = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
            const res1 = await ctx.reg.coord.submit(launcher(m, ctx, null), { scope: scopeOf(ctx), agent: m.name, session: sid, mode: 'queue', text: userText || '(attachment)', message: { role: 'user', content: lastUser?.content ?? '' }, body: payload, modes: ['queue'], idleOnly: true });
            return runs.attach(req, res, runs.get(scopeOf(ctx), m.name, res1.run_id));
          }
          if (route === 'sessions') { // hub-side history (no native sessions on these agents); retention is a per-user setting
            if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, history.list(m.name, { limit: pageInt(url.searchParams.get('limit'), 1, 100, 30), offset: pageInt(url.searchParams.get('offset'), 0, 100000, 0), q: (url.searchParams.get('q') || '').slice(0, 200) }));
            if (parts.length === 6 && parts[5] === 'messages' && req.method === 'GET') return sendJson(res, 200, history.messages(m.name, sessionId(parts[4]), { limit: pageInt(url.searchParams.get('limit'), 1, 200, 80), offset: pageInt(url.searchParams.get('offset'), 0, 100000, 0) }));
            if (parts.length === 5 && req.method === 'PATCH') { const b = await readJson(req, 4096); return sendJson(res, 200, await history.rename(m.name, sessionId(parts[4]), b.title)); }
            if (parts.length === 5 && req.method === 'DELETE') { await history.remove(m.name, sessionId(parts[4])); return sendJson(res, 200, { ok: true }); }
          }
          throw fault(404, 'Not available for this agent');
        }
        if (kindOf(m) === 'mcp-inbox') {
          if (route === 'chat' && parts.length === 4 && req.method === 'POST') {
            const data = await readJson(req, LIMITS.json), payload = chatBody(data); current(m);
            const last = [...payload.messages].reverse().find((x) => x.role === 'user');
            if (!last) throw fault(400, 'Invalid chat messages');
            const { thread } = inbox.fromOwner(m.name, data.session_id, last.content), who = m.label || m.name;
            return sse(res, `📬 Delivered to ${who}'s inbox. The reply will appear in this conversation when ${who} checks in.`, { 'X-Hermes-Session-Id': thread });
          }
          if (route === 'sessions' && parts.length === 4 && req.method === 'GET') return sendJson(res, 200, { sessions: inbox.sessions(m.name) });
          if (route === 'sessions' && parts.length === 6 && parts[5] === 'messages' && req.method === 'GET') return sendJson(res, 200, inbox.messages(m.name, sessionId(parts[4])));
          throw fault(404, 'Not available for this agent');
        }
        if (route === 'files' && parts.length === 4 && req.method === 'POST') {
          const declared = Number(req.headers['content-length']);
          if (!Number.isFinite(declared) || declared < 1) { req.resume(); throw fault(411, 'Content-Length required'); }
          if (declared > LIMITS.file) { req.resume(); throw fault(413, `File too large (max ${LIMITS.file / 1024 / 1024} MB)`); }
          const name = safeFileName(url.searchParams.get('name')), day = new Date().toISOString().slice(0, 10);
          const target = `${m.uploadDir || '~/foxfleet-uploads'}/${day}/${Date.now().toString(36)}-${name}`;
          const mime = /^[\w.+-]+\/[\w.+-]+$/.test(url.searchParams.get('type') || '') ? url.searchParams.get('type') : 'application/octet-stream';
          // Refresh the dashboard session first: a streamed body cannot be replayed after a 401.
          await upstreamJson(await upstream.dashboard(m, '/api/sessions?limit=1')).catch(() => {});
          current(m);
          const boundary = '----foxfleet' + randomBytes(12).toString('hex');
          const field = (k, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
          async function* multipart() {
            yield Buffer.from(field('path', target) + field('overwrite', 'false') + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(name)}"\r\nContent-Type: ${mime}\r\n\r\n`);
            let size = 0;
            for await (const chunk of req) { size += chunk.length; if (size > LIMITS.file || size > declared) throw fault(413, 'File too large'); yield chunk; }
            if (size !== declared) throw fault(400, 'Upload was cut short');
            yield Buffer.from(`\r\n--${boundary}--\r\n`);
          }
          const abort = new AbortController(); res.once('close', () => { if (!res.writableEnded) abort.abort(); });
          const timer = setTimeout(() => abort.abort(), 10 * 60_000); timer.unref();
          try {
            const r = await upstream.dashboard(m, '/api/files/upload-stream', { method: 'POST', stream: true, signal: abort.signal, duplex: 'half', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: Readable.from(multipart()) });
            if (!r.ok) { await r.body?.cancel(); throw fault([403, 409, 413].includes(r.status) ? r.status : 502, r.status === 413 ? 'File too large for the agent' : r.status === 403 ? 'Agent refused the upload path' : 'Agent upload failed'); }
            const result = await upstreamJson(r); current(m);
            return sendJson(res, 201, { name, path: typeof result?.path === 'string' ? result.path : target, size: declared, mime });
          } finally { clearTimeout(timer); }
        }
        if (route === 'transcribe' && parts.length === 4 && req.method === 'POST') {
          const data = await readJson(req, LIMITS.transcribe);
          if (typeof data.data_url !== 'string' || !/^data:(audio\/[\w.+-]+|video\/webm)(;[\w=.+-]+)*;base64,/.test(data.data_url)) throw fault(400, 'Invalid audio payload');
          current(m);
          const r = await upstream.dashboard(m, '/api/audio/transcribe', { method: 'POST', stream: true, signal: AbortSignal.timeout(90_000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data_url: data.data_url, ...(typeof data.mime_type === 'string' && data.mime_type.length < 100 ? { mime_type: data.mime_type } : {}) }) });
          const result = await upstreamJson(r); current(m);
          return sendJson(res, 200, { transcript: typeof result?.transcript === 'string' ? result.transcript : '', provider: typeof result?.provider === 'string' ? result.provider : null });
        }
        if (route === 'screen' && parts.length === 5) {
          const action = parts[4];
          if (req.method === 'GET' && action === 'status') return sendJson(res, 200, await screens.status(m));
          if (req.method === 'POST' && ['start', 'observe', 'takeover', 'handback'].includes(action)) { await readJson(req); current(m); return sendJson(res, 200, await screens[action](m)); }
        }
        if (route === 'chat' && parts.length === 4 && req.method === 'POST' && nativeUi(m)) {
          const data = await readJson(req, LIMITS.chat), payload = chatBody(data); current(m);
          const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'), flat = flattenContent(lastUser?.content), userText = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
          const r = await facade.send(ctx.reg.native, { scope: scopeOf(ctx), m, session: data.session_id, text: userText || '(attachment)', mode: 'auto', idleOnly: true });
          if (!r.run) throw fault(409, 'Hermes did not start a reply for this message; check the conversation');
          return runs.attach(req, res, r.run);
        }
        if (route === 'chat' && parts.length === 4 && req.method === 'POST') {
          const data = await readJson(req, LIMITS.chat), payload = chatBody(data);
          current(m);
          const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'), flat = flattenContent(lastUser?.content), userText = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
          const res1 = await ctx.reg.coord.submit(launcher(m, ctx, await nativeFor(m)), { scope: scopeOf(ctx), agent: m.name, session: validSessionId(data.session_id) ? data.session_id : '', mode: 'queue', text: userText || '(attachment)', message: { role: 'user', content: lastUser?.content ?? '' }, body: payload, modes: ['queue'], idleOnly: true });
          return runs.attach(req, res, runs.get(scopeOf(ctx), m.name, res1.run_id));
        }
        if (route === 'artifacts') {
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, { artifacts: artifacts.list(m, url.searchParams.get('session_id')) });
          if (parts.length === 4 && req.method === 'POST') { const data = await readJson(req), session = sessionId(data.session_id); current(m); const transcript = await upstream.messages(m, session); current(m); return sendJson(res, 201, { artifacts: artifacts.register(m, session, data.paths, transcript) }); }
          if (parts.length === 6 && parts[5] === 'content' && req.method === 'GET') {
            const a = artifacts.get(m, parts[4]), download = url.searchParams.get('download') === '1', text = ['text', 'doc', 'code', 'table'].includes(a.kind), range = req.headers.range;
            if (range && !/^bytes=\d*-\d*$/.test(range)) throw fault(400, 'Invalid byte range');
            const remote = '/api/fs/download?' + new URLSearchParams({ path: a.path, session_id: a.session_id });
            const headers = { 'Content-Type': (text ? 'text/plain; charset=utf-8' : a.mime), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; media-src 'none'", 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Disposition': `${download || a.kind === 'binary' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.name)}` };
            if (text && !download) { const r = await upstream.dashboard(m, remote); if (!r.ok) { await r.body?.cancel(); throw fault([403, 404, 405, 409, 413].includes(r.status) ? r.status : 502, FILE_UNAVAILABLE); } const bytes = await boundedBytes(r, 512 * 1024); current(m); res.writeHead(200, headers); return res.end(bytes); }
            return await streamResponse(req, res, (signal) => upstream.dashboard(m, remote, { stream: true, signal, headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) } }), timeoutMs, (r) => {
              current(m);
              // Native fetch decodes compressed bodies but leaves their wire headers.
              const encoded = r.headers.has('content-encoding') && r.headers.get('content-encoding').toLowerCase() !== 'identity';
              if (encoded && (range || r.status === 206)) throw fault(502, 'Compressed artifact ranges are unavailable');
              const metadata = encoded ? [] : ['content-length', 'content-range', 'accept-ranges'];
              return { ...headers, ...Object.fromEntries(metadata.filter((key) => r.headers.has(key)).map((key) => [key, r.headers.get(key)])) };
            }, FILE_UNAVAILABLE);
          }
        }
        if (route === 'sessions' && parts.length === 4 && req.method === 'GET') {
          const limit = pageInt(url.searchParams.get('limit'), 1, 100, 30), offset = pageInt(url.searchParams.get('offset'), 0, 100000, 0), q = (url.searchParams.get('q') || '').slice(0, 200);
          const data = await upstreamJson(await upstream.dashboard(m, q ? '/api/sessions/search?q=' + encodeURIComponent(q) : `/api/sessions?limit=${limit}&offset=${offset}&order=recent`)), rows = Array.isArray(data?.sessions) ? data.sessions : Array.isArray(data) ? data : [];
          return sendJson(res, 200, agentData(m, route, { sessions: rows.filter((r) => r?.id != null).map(sessionRow), total: Number.isInteger(data?.total) ? data.total : rows.length, limit, offset }, originalConnections));
        }
        if (route === 'sessions' && parts.length === 6 && parts[5] === 'messages' && req.method === 'GET') {
          const limit = pageInt(url.searchParams.get('limit'), 1, 200, 80), offset = pageInt(url.searchParams.get('offset'), 0, 100000, 0), raw = (await upstream.messages(m, sessionId(parts[4]), { limit, offset })).messages;
          return sendJson(res, 200, agentData(m, route, { messages: normalizeTranscript(raw), offset, limit, has_more: raw.length >= limit }, originalConnections));
        }
        if (route === 'sessions' && parts.length === 5 && req.method === 'PATCH') { const b = await readJson(req, 4096); current(m); if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw fault(400, 'Invalid title'); await upstreamJson(await upstream.dashboard(m, '/api/sessions/' + encodeURIComponent(sessionId(parts[4])), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: b.title.trim() }) })); return sendJson(res, 200, { id: parts[4], title: b.title.trim() }); }
        if (route === 'sessions' && parts.length === 5 && req.method === 'DELETE') { current(m); await upstreamJson(await upstream.dashboard(m, '/api/sessions/' + encodeURIComponent(sessionId(parts[4])), { method: 'DELETE' })); return sendJson(res, 200, { ok: true }); }
        let remote, opts = {};
        if (req.method === 'GET' && parts.length === 4) remote = { sessions: '/api/sessions?limit=50', cron: '/api/cron/jobs', skills: '/api/skills', config: '/api/config', profiles: '/api/profiles' }[route];
        if (req.method === 'GET' && route === 'usage' && parts.length === 4) { const days = url.searchParams.get('days') || '30'; if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 365) throw fault(400, 'Invalid usage period'); remote = '/api/analytics/usage?days=' + days; }
        if (req.method === 'GET' && route === 'sessions' && parts.length === 5 && parts[4] === 'search') { const q = url.searchParams.get('q') || ''; if (q.length > 500) throw fault(400, 'Search too long'); remote = '/api/sessions/search?q=' + encodeURIComponent(q); }
        if (req.method === 'GET' && route === 'logs' && parts.length === 4) { const tail = url.searchParams.get('tail') || '100', level = url.searchParams.get('level') || ''; if (!/^\d{1,4}$/.test(tail) || Number(tail) > 1000 || !['', 'debug', 'info', 'warning', 'warn', 'error', 'critical'].includes(level)) throw fault(400, 'Invalid log filter'); remote = '/api/logs?' + new URLSearchParams({ tail, level }); }
        if (req.method === 'POST' && route === 'skills' && parts.length === 5 && parts[4] === 'toggle') { const data = await readJson(req); current(m); if (!identifier(data.name) || typeof data.enabled !== 'boolean') throw fault(400, 'Invalid skill toggle'); remote = '/api/skills/toggle'; opts = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: data.name, enabled: data.enabled }) }; }
        if (req.method === 'POST' && route === 'cron' && parts.length === 6) { if (!identifier(parts[4]) || !['pause', 'resume', 'trigger'].includes(parts[5])) throw fault(400, 'Invalid cron action'); remote = `/api/cron/jobs/${encodeURIComponent(parts[4])}/${parts[5]}`; opts.method = 'POST'; }
        if (remote) return sendJson(res, 200, agentData(m, route, await upstreamJson(await upstream.dashboard(m, remote, opts)), originalConnections));
      }
      if (parts[0] === 'api') throw fault(404, 'Not found');
      if (req.method !== 'GET') throw fault(405, 'Method not allowed');
      return await serveStatic(url, res, avatarBase);
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); return; }
      sendJson(res, error.safe ? error.status : 500, { error: error.safe ? error.message : 'Hub request failed' }, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    }
  }));
  // Whole-request timeout must cover a 90 MB upload on a slow phone link; headers stay strict.
  server.requestTimeout = 10 * 60_000; server.headersTimeout = 10000;
  server.on('upgrade', (req, socket, head) => {
    const deny = (status, text) => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    socket.on('error', () => socket.destroy());
    (async () => {
      const url = new URL(req.url, 'http://hub'), parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (req.headers.upgrade?.toLowerCase() !== 'websocket') return deny(404, 'Not Found');
      boundary(req, server);
      if (url.pathname === '/connector') { // a machine dials out: credential is its machine token in the subprotocol list
        authThrottle(req);
        const token = String(req.headers['sec-websocket-protocol'] || '').split(',').map((v) => v.trim()).find((v) => /^[0-9a-f]{32}\.[\w-]{20,100}$/.test(v));
        const machine = token ? machines.authenticate(token) : null;
        if (!machine) return deny(401, 'Unauthorized');
        await machines.touch(machine.id);
        return void connectors.attach(machine.id, wsAccept(req, socket, { protocol: 'foxfleet.v1' }), { onProfiles: (msg, link) => { machines.touch(machine.id, { os: ['linux', 'darwin', 'win32'].includes(msg.os) ? msg.os : undefined }).catch(() => {}); return syncProfiles(machine, msg, link); } });
      }
      if (!(parts.length === 5 && parts[0] === 'api' && parts[1] === 'agents' && parts[3] === 'screen' && parts[4] === 'ws')) return deny(404, 'Not Found');
      // A browser always sends Origin on a WebSocket upgrade: it must be this hub, or the Android
      // app's bundled noVNC page (WebViewAssetLoader origin). That page cannot carry the session
      // credential cross-site, so for it the single-use ticket (minted by an authenticated
      // POST .../screen/observe, 30 s, bound to this agent) is the credential.
      const origin = req.headers.origin, fromHub = origin && (trusted.has(origin) || origin === `http://${req.headers.host}`);
      if (!fromHub && origin !== APP_ORIGIN) return deny(403, 'Forbidden');
      let regs;
      if (fromHub) { const auth = await identify(req); if (!auth) return deny(401, 'Unauthorized'); regs = [await registryFor(auth.user.id, auth.user.role === 'owner')]; } else regs = await allRegistries();
      for (const reg of regs) {
        let m; try { m = reg.store.get(parts[2]); } catch { continue; }
        let ticket; try { ticket = reg.screens.consume(url.searchParams.get('ticket'), m.name); } catch { continue; }
        return reg.screens.proxy(req, socket, head, ticket);
      }
      return deny(403, 'Forbidden');
    })().catch((error) => deny(error.status === 401 ? 401 : error.status === 404 ? 404 : 403, error.status === 401 ? 'Unauthorized' : error.status === 404 ? 'Not Found' : 'Forbidden'));
  });
  server.on('close', () => { authFails.clear(); connectors.closeAll(); for (const p of registries.values()) p.then((r) => { r.upstream.clear(); r.artifacts.clear(); r.screens.clear(); }); });
  server.connectors = connectors; // test seam: native UI calls go through the machine connector
  // Upgraded sockets (screen proxy, gateway client) are not HTTP connections; end them on close.
  const originalClose = server.close;
  server.close = function (...args) { connectors.closeAll(); for (const p of registries.values()) p.then((r) => r.screens.clear()); return originalClose.apply(this, args); };
  // A caller cannot bypass the LAN-password rule by rebinding a loopback-created hub.
  const originalListen = server.listen;
  server.listen = function (...args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined, first = args.shift();
    let options;
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      if (args.length || ['fd', 'path', 'handle'].some((key) => key in first) || !('port' in first)) throw fault(400, 'Unsupported listener options; use a TCP port');
      options = { ...first, host: first.host ?? host };
    } else {
      options = { port: first, host };
      if (typeof args[0] === 'string') options.host = args.shift();
      else if (args.length && args[0] == null) args.shift();
      if (typeof args[0] === 'number') options.backlog = args.shift();
      if (args.some((arg) => arg != null)) throw fault(400, 'Unsupported listener arguments');
    }
    if (typeof options.port === 'string' && /^\d+$/.test(options.port)) options.port = Number(options.port);
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw fault(400, 'Invalid listener port');
    if (!validHost(options.host)) throw fault(400, 'Invalid bind host');
    if (!loopback(options.host) && singleUser) throw fault(400, 'Single-user mode (no login) is only allowed on a loopback bind');
    return originalListen.call(this, options, ...(callback ? [callback] : []));
  };
  server.setupCode = setupCode; server.accounts = accounts;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.FOXFLEET_PORT || process.env.PORT || 3080), host = process.env.FOXFLEET_HOST || '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault(400, 'Invalid relay port');
    const server = await createHub({ host });
    server.on('error', () => { console.error('Foxfleet could not start'); process.exitCode = 1; });
    server.listen(port, host, () => { console.log(`Foxfleet listening on ${host}:${port}`); if (server.setupCode) console.log(`First-run setup code (needed to create the owner account): ${server.setupCode}`); });
    const shutdown = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) { console.error(error.safe ? error.message : 'Foxfleet could not start'); process.exitCode = 1; }
}
