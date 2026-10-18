// Foxfleet relay: secrets stay server-side; importing never opens a listener.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { configStore, publicConnection, fault, identifier, validHost, secretsOf, connection as validateConnection, kindSpecs, capabilitiesOf, BOT_CAPABILITIES, redact } from './config.js';
import { redact as redactStep } from './steps.js'; // step labels: patterns + the connections' own secrets
import { hermesClient, upstreamJson, boundedBytes, safeAgentData } from './hermes.js';
import { artifactRegistry } from './artifacts.js';
import { scanAvatarPacks } from './avatars.js';
import { screenRelay } from './screen.js';
import { runRegistry } from './runs.js';
import { coordinator } from './coordinator.js';
import { nativeFeatures, busyModes, nativeRun, nativeControl } from './hermes-runs.js';
import { nativeHub } from './hermes-ui.js';
import { nativeFacade, viewOf } from './native-facade.js';
import { applyLive, catalogFor, readLiveCatalog } from './commands.js';
import { activityStore, sortAgents } from './activity.js';
import { normalizeTranscript, sessionRow, flattenContent, cleanText } from './transcript.js';
import { readFileSync } from 'node:fs';
import { accountStore, SESSION_AGE as ACCOUNT_SESSION_AGE } from './accounts.js';
import { connectorHub } from './connector.js';
import { notifyStore, attachNotifyStream, closeDeviceStreams } from './notify.js';
import { liveBus, attachLiveStream } from './live.js';
import { liveLog, attachLive2Stream, retentionFromEnv, PULL_MAX, PULL_DEFAULT } from './live2.js';
import { chatLedger, hubIdOf, clipText } from './ledger.js';
import { replyTokens } from './reply-tokens.js';
import { machineStore, normalizeCode, validCode, formatCode } from './machines.js';
import { wsAccept } from './ws.js';
import { createBotApi, disabledBotProbe, botDisabled } from './bot-api.js';
import { qrSvg, qrRows } from './qr.js';
import { fetchImage } from './media-proxy.js';
import { mediaHub } from './media.js';
import { reactionStore, agentReactions, reactionView, replyReaction } from './reactions.js';
import { TERMS_VERSION, acceptedTerms } from './legal.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';

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
// What this hub build can do, so a newer app can tell "this hub is too old" instead of showing nothing. Add a name when a feature ships; never remove one.
/** Opt-in diagnostics (FOXFLEET_DEBUG=1): one JSON line per event, never message text or addresses. */
const log = (event, data = {}) => { if (process.env.FOXFLEET_DEBUG) console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data })); };
export const HUB_FEATURES = ['screenErrors', 'media', 'mediaTags', 'agentActivity', 'pin', 'hubInfo', 'notify', 'live', 'live2', 'chats', 'readReceipts', 'notifyReply', 'reactionEvents'];
const HUB_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; } })();
export const HUB_INFO = { version: HUB_VERSION, features: HUB_FEATURES };
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
async function readJson(req, limit = BODY_LIMIT) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); throw fault(413, 'Request body too large'); }
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) { req.resume(); throw fault(413, 'Request body too large'); } chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw fault(400, 'Invalid JSON body'); }
}
const pageInt = (v, lo, hi, d) => { const n = Number(v ?? d); return Number.isInteger(n) ? Math.min(Math.max(n, lo), hi) : d; };
const validSessionId = (s) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(String(s ?? ''));
/** A new chat's id, minted by the hub in Hermes's own shape (YYYYMMDD_HHMMSS_hex, UTC) so it reads like the agent's other sessions. */
const newChatId = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}_${randomBytes(4).toString('hex')}`; };
/** The chat a run belongs to: Hermes's answer when it names a usable one, else the id the hub sent. */
const chatIdOf = (r, sent) => { const up = r.headers.get('x-hermes-session-id'); return validSessionId(up) ? up : sent; };
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
/** data:image/...;base64 pictures from a user message (what the apps send). Only these can be handed to Hermes' image.attach_bytes. */
export function userImages(flat) { return (flat?.images ?? []).filter((u) => typeof u === 'string' && /^data:image\/(?:png|jpe?g|gif|webp|bmp|heic|heif|avif);base64,[A-Za-z0-9+\/=]+$/i.test(u)).slice(0, 4); }
const safeFileName = (value) => {
  const base = String(value || '').split(/[\\/]/).pop().normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').replace(/[^\p{L}\p{N} ._()+-]/gu, '_').replace(/^\.+/, '').slice(-120).trim();
  return base || 'file';
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

export async function createHub({ configPath = process.env.FOXFLEET_CONFIG || path.join(DIR, 'config.json'), host = process.env.FOXFLEET_HOST || '127.0.0.1', ownerPassword = process.env.FOXFLEET_PASSWORD || '', singleUser = false, trustedOrigins = process.env.FOXFLEET_TRUSTED_ORIGINS || '', timeoutMs = 5000, probeTtlMs = 10_000, avatarDir, botApi = process.env.FOXFLEET_BOT_API === '1', botAgents = process.env.FOXFLEET_BOT_AGENTS, botOptions = {}, replyRatePerMin = 30, liveClock } = {}) {
  if (!validHost(host)) throw fault(400, 'Invalid bind host');
  if (typeof ownerPassword !== 'string' || ownerPassword.length > 4096) throw fault(400, 'Invalid owner password');
  if (singleUser && !loopback(host)) throw fault(400, 'Single-user mode (no login) is only allowed on a loopback bind');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) throw fault(400, 'Invalid timeout');
  if (avatarDir !== undefined && (typeof avatarDir !== 'string' || !path.isAbsolute(avatarDir) || avatarDir.includes('\0'))) throw fault(400, 'Invalid avatar directory');
  const trusted = trustedOriginList(trustedOrigins);
  const trustedList = trusted, cfgPath = path.resolve(configPath), dataDir = path.dirname(cfgPath), avatarBase = avatarDir ? path.resolve(avatarDir) : DEFAULT_AVATAR_DIR;
  await mkdir(dataDir, { recursive: true });
  const accounts = await accountStore(path.join(dataDir, 'accounts'));
  const tokens = await replyTokens(path.join(dataDir, 'reply-token.key')), retention = retentionFromEnv();
  accounts.onSessionEnd((device) => closeDeviceStreams(device)); // a revoked / expired / signed-out device must not keep receiving notifications
  // Legacy FOXFLEET_PASSWORD bootstraps the first owner ("owner") so existing deployments keep working.
  if (ownerPassword && accounts.needsSetup()) await accounts.createUser('owner', ownerPassword, 'owner', { skipPolicy: true });
  const setupCode = accounts.needsSetup() && !loopback(host) ? (process.env.FOXFLEET_SETUP_CODE || randomBytes(9).toString('base64url')) : '';
  const machines = await machineStore(path.join(dataDir, 'machines.json'));
  const runs = runRegistry();
  runs.onStart((r) => { void registries.get(r.scope)?.then((reg) => reg.live.fromRunStart(r)).catch(() => {}); });
  // 0.4.1 reactions (docs/LIVE-EVENTS.md "Reactions"): stored rows of one message under either of its ids, the live event, and the
  // agent's REACT: line applied when its reply is committed.
  const agentActor = (m) => ({ id: 'agent:' + m.name, name: m.label || m.name, kind: 'agent' });
  function storedReactions(reg, agent, chat, ref) {
    const rows = reg.reactions.list(agent, chat), keys = [ref.u, ref.hub_id].filter(Boolean);
    return reactionView({ rows: Object.fromEntries(Object.entries(rows).filter(([k]) => keys.includes(k))), resolve: () => ref }).by_hub_id[ref.hub_id] ?? [];
  }
  const reactionEvent = (reg, agent, chat, ref, groups, change) => reg.live2.emit('message.reaction', { agent, chat, hub_id: ref.hub_id, upstream_id: ref.u ?? null, reactions: groups, change });
  async function agentReacts(reg, m, chat, msg, text) {
    const { react } = replyReaction(text); if (!react) return;
    const ref = reg.ledger.userBefore(m.name, chat, msg.n); if (!ref) return;
    const actor = agentActor(m);
    try { if (await reg.reactions.set(m.name, chat, [ref.u, ref.hub_id].filter(Boolean), react, actor, true)) reactionEvent(reg, m.name, chat, ref, storedReactions(reg, m.name, chat, ref), { emoji: react, present: true, actor }); }
    catch { /* a full store keeps the reply; the reaction is still derived from the transcript */ }
  }
  /** The chat's reactions as the snapshot shows them: stored (by upstream or hub id) plus REACT: lines in the transcript. */
  /**
   * REACT: lines the hub did not see being committed (a reply written elsewhere, or before 0.4.1) are found when a chat is read
   * (reactions snapshot, history). The first time, each is stored for the agent and sent once as message.reaction, so every device
   * learns it from the live log and not only from its next snapshot. At most 20 per read; nothing when they are known already.
   */
  async function announceDerived(reg, m, sid, transcript) {
    const derived = agentReactions(transcript, agentActor(m)); if (!derived.length) return;
    const rows = reg.reactions.list(m.name, sid); let left = 20;
    for (const d of derived) {
      const ref = reg.ledger.resolve(m.name, sid, d.message); if (!ref) continue;
      const keys = [ref.u, ref.hub_id].filter(Boolean);
      if (keys.some((k) => rows[k]?.some((g) => g.emoji === d.emoji && g.actors.some((a) => a.id === d.actor.id)))) continue;
      if (left-- <= 0) break;
      try { if (await reg.reactions.set(m.name, sid, keys, d.emoji, d.actor, true)) reactionEvent(reg, m.name, sid, ref, storedReactions(reg, m.name, sid, ref), { emoji: d.emoji, present: true, actor: d.actor }); } catch { /* full store: still derived on read */ }
    }
  }
  /** History messages gain `reactions` (when any) and, on replies, `react` / `reaction_only` (0.4.1). */
  function withReactions(reg, m, sid, list) {
    let v; try { v = reactionsOf(reg, m, sid, list); } catch { return list; }
    for (const x of list) {
      const g = (x.hub_id && v.by_hub_id[x.hub_id]) || (x.id != null && v.messages[String(x.id)]); if (g?.length) x.reactions = g;
      if (x.role === 'assistant' && typeof x.content === 'string') { const rr = replyReaction(x.content); if (rr.react) x.react = rr.react; if (rr.only) x.reaction_only = true; }
    }
    return list;
  }
  const reactionsOf = (reg, m, sid, transcript) => reactionView({ rows: reg.reactions.list(m.name, sid), derived: agentReactions(transcript, agentActor(m)), resolve: (k) => reg.ledger.resolve(m.name, sid, k), transcriptIds: new Set(transcript.filter((x) => x.id != null).map((x) => String(x.id))) });

  // Live v2 (docs/LIVE-EVENTS.md): run notices, typing, the agent's reply as message.new, and the user's message statuses.
  const withReg = (scope, fn) => { void registries.get(scope)?.then(fn).catch(() => {}); };
  runs.onStart((r) => withReg(r.scope, (reg) => { reg.live2.emit('run.started', { agent: r.agent, chat: r.session ?? undefined, run_id: r.id }); typingSet(reg, r, 'thinking', null); rowChanged(reg, r.scope, r.agent); }));
  runs.onEvent((r, kind, tool, x = {}) => withReg(r.scope, (reg) => {
    typingSet(reg, r, kind, tool, x);
    if (x.step && r.session && !r.done) reg.live2.ephemeral('run.step', { agent: r.agent, chat: r.session, run_id: r.id, ...x.step, at: Date.now() }); // ephemeral: never stored or replayed
    if (!r.ledgerRead && r.session) { r.ledgerRead = true; reg.ledger.readByAgent(r.agent, r.session, r); } }));
  runs.onFinish((r, state) => withReg(r.scope, async (reg) => {
    typingStop(r);
    try {
      const cleaned = cleanText(r.text || ''), text = cleaned.text, m = reg.store.all().find((x) => x.name === r.agent), x = runs.extras(r);
      if (r.session && m && state !== 'error' && text.trim()) {
        if (!reg.ledger.has(r.agent, r.session)) await ensureIndexed(reg, m, r.session).catch(() => false);
        if (reg.ledger.has(r.agent, r.session)) {
          reg.ledger.readByAgent(r.agent, r.session, r);
          const msg = reg.ledger.add(r.agent, r.session, { role: 'assistant', text, source: 'agent', runId: r.id, reasoning: [x.reasoning, cleaned.reasoning].filter((v) => v && v.trim()).join('\n\n'), tools: x.tools });
          await agentReacts(reg, m, r.session, msg, text); // 0.4.1: the reply's REACT: line lands on the user's message now, not at the next poll
        }
      }
    } finally { reg.live2.emit('run.finished', { agent: r.agent, chat: r.session ?? undefined, run_id: r.id, state: state === 'error' ? 'error' : state === 'stopped' ? 'stopped' : 'done' }); rowChanged(reg, r.scope, r.agent); }
  }));
  runs.onFinish((r, state) => { void registries.get(r.scope)?.then((reg) => reg.live.fromRunFinish(r, state)).catch(() => {}); });
  runs.onFinish((r, state) => { void registries.get(r.scope)?.then((reg) => reg.notify.fromRun(r, state)).catch(() => {}); });
  runs.onFinish((r, state) => { if (r.text && state !== 'error') void registries.get(r.scope)?.then((reg) => reg.activity.touch(r.agent, { role: 'assistant', text: r.text, session: r.session ?? undefined })); }); const facade = nativeFacade({ runs }), connectors = connectorHub(), als = new AsyncLocalStorage(), registries = new Map(), authFails = new Map();
  // Per-user registry: own agents, secrets, upstream caches and screen tickets. Handlers reach it through these scoped views.
  function registryFor(userId, owner) {
    if (!registries.has(userId)) registries.set(userId, (async () => {
      const dir = owner ? dataDir : path.join(dataDir, 'users', userId); await mkdir(dir, { recursive: true });
      const up = hermesClient(timeoutMs), reg = { dir, store: await configStore(owner ? cfgPath : path.join(dir, 'config.json')), upstream: up, artifacts: artifactRegistry(), screens: screenRelay(up), activity: await activityStore(path.join(dir, 'activity.json')) };
      reg.reactions = await reactionStore(path.join(dir, 'reactions.json'));
      reg.coord = await coordinator(path.join(dir, 'queue.json'), { runs, stopWaitMs: Number(process.env.FOXFLEET_STOP_WAIT_MS) || 15_000 }); reg.native = await nativeHub({ connectors, file: path.join(dir, 'native-journal.json') }); facade.attachHooks(reg.native);
      reg.notify = await notifyStore(path.join(dir, 'notify.json')); reg.live = liveBus();
      reg.live2 = await liveLog(path.join(dir, 'live-events'), { ...retention, now: liveClock });
      reg.ledger = await chatLedger(path.join(dir, 'chats.json'), { idemMax: Math.max(500, replyRatePerMin * 60 * 24), hooks: { reactions: (agent, chat, ref) => storedReactions(reg, agent, chat, ref), event: (type, f) => reg.live2.emit(type, f), changed: (agent) => rowChanged(reg, userId, agent), muted: (agent) => Boolean(reg.notify.muteOf(agent)), known: (agent) => reg.store.all().some((x) => x.name === agent) } });
      reg.native.onRequest((s, e) => { const a = reg.store.all().find((x) => x.machineId === s.machineId && x.profile === s.agent); reg.notify.emit({ type: 'approval', agent: a?.name ?? s.agent, chat: s.stored, request_id: String(e.request_id ?? '').slice(0, 100), kind: String(e.kind ?? 'approval').slice(0, 30) }); reg.live.emit({ type: 'approval', agent: a?.name ?? s.agent, chat: s.stored, request_id: String(e.request_id ?? '').slice(0, 100), kind: String(e.kind ?? 'approval').slice(0, 30) }); reg.live2.emit('approval', { agent: a?.name ?? s.agent, chat: s.stored ?? undefined, request_id: String(e.request_id ?? '').slice(0, 100), kind: String(e.kind ?? 'approval').slice(0, 30) }); rowChanged(reg, userId, a?.name ?? s.agent); });
      return reg;
    })());
    return registries.get(userId);
  }
  // ---- live v2 helpers: typing, chat-list rows, ledger indexing (docs/LIVE-EVENTS.md) ----
  const TYPING_TTL_MS = 6000, TYPING_REPEAT_MS = 4000, typingRuns = new Map(); let typingTimer = null;
  // label (what the step is about: tool arguments, commentary or a status line) and tool_id only appear when known, so plain frames stay as before.
  const typingSend = (t) => { t.sent = Date.now(); t.reg.live2.typing({ agent: t.agent, chat: t.chat, state: t.state, tool: t.tool, ...(t.label ? { label: t.label } : {}), ...(t.toolId ? { tool_id: t.toolId } : {}), ttl_ms: TYPING_TTL_MS }); };
  const oneLine = (v, n) => String(v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n);
  function typingSet(reg, r, state, tool, x = {}) {
    if (!r.session || r.done) return;
    let t = typingRuns.get(r.id); if (!t) { t = { reg, agent: r.agent, chat: r.session, state: null, tool: null, label: null, toolId: null, sent: 0 }; typingRuns.set(r.id, t); }
    if (!state) { if (!x.label || !t.state) return; state = t.state; tool = t.tool; } // a label-only step (commentary, status) keeps the current state
    const name = state === 'tool' && tool ? oneLine(redactStep(String(tool)), 80) : null, label = x.label ? oneLine(redactStep(String(x.label)), 200) : null, toolId = state === 'tool' && x.toolId ? oneLine(x.toolId, 120) : null;
    if (t.state !== state || t.tool !== name || t.label !== label || t.toolId !== toolId || Date.now() - t.sent >= TYPING_REPEAT_MS) { t.state = state; t.tool = name; t.label = label; t.toolId = toolId; typingSend(t); }
    if (!typingTimer) { typingTimer = setInterval(() => { const n = Date.now(); for (const x of typingRuns.values()) if (n - x.sent >= TYPING_REPEAT_MS) typingSend(x); if (!typingRuns.size) { clearInterval(typingTimer); typingTimer = null; } }, 1000); typingTimer.unref?.(); }
  }
  function typingStop(r) { const t = typingRuns.get(r.id); if (!t) return; typingRuns.delete(r.id); t.state = 'idle'; t.tool = null; t.label = null; t.toolId = null; typingSend(t); }
  /** One chat-list row (docs/LIVE-EVENTS.md ChatRow). */
  function chatRow(reg, scope, m) {
    const L = reg.ledger, a = L.agent(m.name), label = m.label || m.name, last = L.lastMessage(m.name), act = reg.activity.get(m.name);
    const pins = reg.activity.pins(), pi = pins.indexOf(m.name), chat = L.latest(m.name) ?? act?.session ?? null;
    const lm = last ? { hub_id: hubIdOf(m.name, last.chat, last.e.n), role: last.e.r, sender: last.e.r === 'user' ? 'you' : label, preview: last.e.p, at: last.e.at, ...(last.e.r === 'user' && last.e.st ? { status: last.e.st } : {}) }
      : act?.preview ? { hub_id: null, role: act.role, sender: act.role === 'user' ? 'you' : label, preview: String(act.preview).slice(0, 160), at: act.at } : null;
    const needs = kindOf(m) === 'hermes' && nativeUi(m) && m.machineId ? reg.native.openRequests(scope, m.machineId, m.profile) > 0 : false;
    return { agent: m.name, label, kind: kindOf(m), chat, last_message: lm, unread_count: L.agentUnread(m.name), read_up_to: chat ? L.readUpTo(m.name, chat) : 0, archived: Boolean(a?.archived), muted: reg.notify.muteOf(m.name),
      pinned: pi >= 0, pin_order: pi >= 0 ? pi : null, working: runs.working(scope, m.name), needs_input: needs, manual_unread: Boolean(a?.manual), updated_at: Math.max(a?.updated ?? 0, lm?.at ?? 0) };
  }
  const sortRows = (rows, order) => rows.sort((x, y) => { const px = x.pin_order ?? -1, py = y.pin_order ?? -1; if ((px >= 0) !== (py >= 0)) return px >= 0 ? -1 : 1; if (px >= 0) return px - py; const tx = x.last_message?.at ?? 0, ty = y.last_message?.at ?? 0; if (tx !== ty) return ty - tx; return order.indexOf(x.agent) - order.indexOf(y.agent); });
  /** chat.updated, coalesced: every change in one tick costs one event per agent, after the events that caused it. */
  function rowChanged(reg, scope, agent) {
    if (!reg?.live2 || typeof agent !== 'string') return;
    (reg.dirtyRows ??= new Set()).add(agent);
    if (!reg.rowTimer) reg.rowTimer = setImmediate(() => { reg.rowTimer = null; const names = [...reg.dirtyRows]; reg.dirtyRows.clear(); for (const n of names) { const m = reg.store.all().find((x) => x.name === n); if (m) { try { reg.live2.emit('chat.updated', { agent: n, row: chatRow(reg, scope, m) }); } catch { /* best effort */ } } } });
  }
  // The first time the hub sees a chat it numbers the agent's whole transcript (silently: old history is not unread). Single-flight.
  const ensuring = new Map();
  function ensureIndexed(reg, m, chat) {
    if (reg.ledger.has(m.name, chat)) return Promise.resolve(true);
    if (m.connection === 'bot') return Promise.resolve(false);
    const k = `${reg.dir}\0${m.name}\0${chat}`; if (ensuring.has(k)) return ensuring.get(k);
    const p = (async () => { const msgs = normalizeTranscript((await reg.upstream.messages(m, chat)).messages); if (!reg.ledger.has(m.name, chat)) reg.ledger.reconcile(m.name, chat, msgs); return true; })().finally(() => ensuring.delete(k));
    ensuring.set(k, p); return p;
  }
  async function ensureOr404(reg, m, chat) {
    if (!validSessionId(chat)) throw fault(404, 'Chat not found', 'chat_not_found');
    let ok; try { ok = await ensureIndexed(reg, m, chat); } catch (e) { if (e?.status === 404 || e?.notFound === true) throw fault(404, 'Chat not found', 'chat_not_found'); throw e; } // the agent knows no such session (both history paths 404)
    if (!ok) throw fault(404, 'Chat not found', 'chat_not_found');
  }
  const sendRefs = new WeakMap(); // the user message object handed to the coordinator -> its ledger entry, so the launch marks the right one delivered
  const sourceOf = (ctx) => (ctx.auth?.via === 'bearer' ? 'app' : 'web');
  /** Coordinator send (non-native agents) with the ledger: the message is numbered before it is queued, then delivered / failed as the coordinator decides. */
  async function submitIndexed(ctx, m, deps, params, source) {
    const reg = ctx.reg, chat = params.session;
    const dup = params.clientId && reg.coord.items().some((i) => i.scope === params.scope && i.agent === params.agent && i.client === params.clientId);
    let msg = null;
    if (!chat && params.message) sendRefs.set(params.message, { chat: null, source });
    if (!dup && chat && m.connection !== 'bot' && params.mode !== 'steer' && params.modes.includes(params.mode) && typeof params.text === 'string' && params.text.length <= 100_000 && (params.text.trim() || Array.isArray(params.message?.content))) {
      try { await ensureIndexed(reg, m, chat); } catch { /* agent unreachable: the send will say so; nothing to number */ }
      if (reg.ledger.has(m.name, chat)) { msg = reg.ledger.add(m.name, chat, { role: 'user', text: params.text, source, status: 'sent' }); sendRefs.set(params.message, { chat, n: msg.n }); }
    }
    let result;
    try { result = await reg.coord.submit(deps, params); }
    catch (e) { if (msg) reg.ledger.setStatus(m.name, chat, (x) => x.n === msg.n, 'failed', { error: e.safe ? e.message : 'Could not send' }); throw e; }
    if (msg) { reg.ledger.setCid(m.name, chat, msg.n, result.message?.id); if (result.message?.state === 'failed') reg.ledger.setStatus(m.name, chat, (x) => x.n === msg.n, 'failed', { error: result.message.error }); }
    return { result, msg };
  }
  /** The coordinator started (or failed to start) a queued message: mark it delivered with its run, or failed. A brand-new chat is numbered here, once its id is known. */
  function launchedInLedger(reg, m, item, run, error) {
    if (m.connection === 'bot') return;
    const ref = sendRefs.get(item.message), chat = run?.session || ref?.chat || item.session; if (!chat) return;
    const n = (ref && ref.chat === chat ? ref.n : null) ?? reg.ledger.entryByCid(m.name, chat, item.id)?.n;
    if (error) { if (n) reg.ledger.setStatus(m.name, chat, (x) => x.n === n, 'failed', { error }); return; }
    if (n) { reg.ledger.setStatus(m.name, chat, (x) => x.n === n, 'delivered', { runId: run.id }); return; }
    if (!item.session || reg.ledger.has(m.name, chat)) { const msg = reg.ledger.add(m.name, chat, { role: 'user', text: item.text, source: ref?.source || 'app', status: 'delivered', runId: run.id, cid: item.id }); if (item.message) sendRefs.set(item.message, { chat, n: msg.n }); }
  }
  /** Native (Hermes UI gateway) send result -> ledger. The chat was indexed before the send (or is brand new). */
  function nativeInLedger(reg, m, r, { text, source, mode, fresh }) {
    const chat = r.stored; if (!chat || mode === 'steer' || m.connection === 'bot') return null;
    if (!fresh && !reg.ledger.has(m.name, chat)) return null;
    const failed = ['rejected', 'failed'].includes(r.message?.state), st = failed ? 'failed' : r.message?.ack ? 'delivered' : 'sent';
    return reg.ledger.add(m.name, chat, { role: 'user', text, source, status: st, runId: st === 'delivered' && r.run ? r.run.id : undefined, error: failed ? r.message?.error || 'The agent refused the message' : undefined });
  }
  const scoped = (key) => new Proxy({}, { get: (_, prop) => { const t = als.getStore()?.reg?.[key]; if (!t) throw fault(401, 'Login required'); const v = t[prop]; return typeof v === 'function' ? v.bind(t) : v; } });
  const store = scoped('store'), upstream = scoped('upstream'), artifacts = scoped('artifacts'), screens = scoped('screens');
  const allRegistries = async () => singleUser ? [await registryFor('local', true)] : Promise.all(accounts.users().map((u) => registryFor(u.id, u.role === 'owner')));
  await allRegistries(); // fail fast on unreadable saved config
  const secureRequest = (req) => req.headers['x-forwarded-proto'] === 'https' || trusted.has(`https://${req.headers.host}`);
  const kindOf = (m) => m.kind || 'hermes';
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
  // FOXFLEET_BOT_AGENTS: comma-separated agent names allowed on the bot API (staged rollout, e.g. "sumi-native").
  // DENY BY DEFAULT: unset or empty = NO bot agent is allowed; "*" = every bot agent. Exact, case-sensitive.
  const botList = typeof botAgents === 'string' ? botAgents.split(',').map((v) => v.trim()).filter(Boolean) : [];
  const botAll = botList.includes('*'), botAllow = new Set(botList.filter((v) => v !== '*'));
  const allowBotAgent = (name) => botAll || botAllow.has(name);
  if (botApi && !botAll && !botAllow.size) console.warn('foxfleet: WARNING FOXFLEET_BOT_API=1 but FOXFLEET_BOT_AGENTS is unset or empty: NO bot agent is allowed (deny by default). Set FOXFLEET_BOT_AGENTS=<name>[,<name>] or "*" for all.');
  const bot = botApi ? await createBotApi({ dataDir, scopeReg: (scope) => registryFor(scope, scope === 'local' || ownerOf(scope)?.role === 'owner'), ownerOf, runs, trusted, appCommands: catalogFor({ kind: 'hermes', bundled: HERMES_COMMANDS.commands.filter((c) => c.availability === 'app' && !['stop', 'queue', 'steer', 'busy'].includes(c.name)), modes: ['queue'] }), options: { ...botOptions, allowAgent: allowBotAgent }, log }) : null;
  const hubInfo = bot ? { ...HUB_INFO, features: [...HUB_FEATURES, 'botApi'] } : HUB_INFO;
  const publicAgent = (m) => ({ ...publicConnection(m), ...(m.connection === 'bot' ? { hasBotToken: Boolean(bot?.hasToken(m.botId)) } : {}) });
  const media = mediaHub({ connectors }); // MEDIA: tags -> cards (see media.js)
  const uniqueName = (reg, base, machineId) => { const taken = new Set(reg.store.all().filter((a) => a.machineId !== machineId || a.profile !== base).map((a) => a.name)); let n = base, i = 2; while (taken.has(n) || reg.store.reserved(n)) n = `${base}-${i++}`; return n; };
  // The connector tells the hub which profiles it exposes; each becomes (or stays) an agent in the owner's registry.
  async function syncProfiles(machine, msg, link) {
    const user = ownerOf(machine.userId); if (!user) throw fault(403, 'Owner is gone');
    if (!machines.get(machine.id)) throw fault(403, 'This machine was revoked'); // a sync already in flight when the machine was removed must not bring its agents back
    const reg = await registryFor(user.id, user.role === 'owner');
    if (!machines.get(machine.id)) throw fault(403, 'This machine was revoked');
    const names = [...new Set((Array.isArray(msg.profiles) ? msg.profiles : []).map((p) => String(p?.profile ?? '')).filter((n) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n)))].slice(0, 32);
    const mine = reg.store.all().filter((a) => a.machineId === machine.id);
    for (const a of mine) if (!names.includes(a.profile)) { await reg.store.remove(a.name); reg.upstream.clear(); reg.ledger.removeAgent(a.name); }
    const out = [];
    for (const profile of names) {
      let a = reg.store.all().find((x) => x.machineId === machine.id && x.profile === profile);
      if (!a) { a = await reg.store.add({ kind: 'hermes', connection: 'machine', machineId: machine.id, profile, name: uniqueName(reg, profile, machine.id) }); rowChanged(reg, user.id, a.name); }
      out.push({ profile, agent: a.name });
    }
    await link.expose(names); await machines.setProfiles(machine.id, out); reg.upstream.clear();
    return { agents: out };
  }
  // The only agent shape clients get: no host, port, URL, profile path or upstream version strings.
  // Negotiation order: native UI gateway (through the machine connector) > HTTP /v1/runs > /v1/chat/completions.
  const nativeUi = (m) => Boolean(kindOf(m) === 'hermes' && m.machineId && connectors.ui(m.machineId)?.caps(m.profile)?.native);
  // Who can deliver this agent's media: the hub (this build), the connector on the agent's machine (needs >= 0.3.5 to report a version; older ones still serve files), and the agent itself.
  function mediaInfo(m) {
    const mach = m.machineId ? machines.get(m.machineId) : null;
    return { hub: true, hubVersion: HUB_VERSION, local: Boolean(m.machineId), connector: mach ? { version: mach.connectorVersion ?? null, online: connectors.isOnline(m.machineId), media: mach.connectorFeatures?.includes('media') ?? false } : null,
      agent: nativeUi(m) ? 'native' : 'http', tags: true, toolMedia: nativeUi(m) };
  }
  function botAgentView(m, p, index) {
    const online = Boolean(p.online), chatReady = Boolean(p.chatReady);
    return { id: m.name, name: m.name, displayName: m.label || m.name, kind: kindOf(m), order: index,
      description: m.description || '', avatar: m.avatar || null,
      status: chatReady ? 'ready' : 'offline', online, chatReady, managementReady: false,
      capabilities: { ...BOT_CAPABILITIES, images: Boolean(p.media), reactions: true, agentReactions: true, busy: ['queue'], nativeUi: false, nativeRuns: false, models: 'none', media: { ...mediaInfo(m), agent: 'http', tags: Boolean(bot), local: Boolean(bot) } },
      ...(p.lastSeen !== undefined ? { lastSeen: p.lastSeen } : {}),
      hasBotToken: Boolean(p.hasBotToken),
      checks: { ...Object.fromEntries(Object.entries(p.checks || {}).map(([k, c]) => [k, { ok: Boolean(c?.ok), message: String(c?.message ?? '') }])), media: { ok: Boolean(bot), message: bot ? 'Bot media via hub' : 'Bot API disabled' } } };
  }
  // How a client changes the model (docs/LIVE-EVENTS.md "Model picker"): 'native' through the native gateway (/native/models, /native/sessions/{id}/model),
  // 'request' through GET /api/agents/{name}/models + a per-chat override the hub sends with each run, 'none' when the agent offers no model list.
  const providersOf = (r) => (Array.isArray(r?.providers) ? r.providers : []).filter((pr) => pr && typeof pr === 'object' && pr.slug != null).map((pr) => ({ slug: String(pr.slug), name: String(pr.name ?? pr.slug), current: pr.is_current === true, models: (Array.isArray(pr.models) ? pr.models : []).map((x) => (typeof x === 'string' ? x : x?.id ?? x?.name)).filter(Boolean).slice(0, 300).map(String) })).slice(0, 60);
  const modelsMode = (m, p) => (nativeUi(m) ? 'native' : kindOf(m) === 'hermes' && p?.capabilities ? 'request' : 'none');
  function agentView(m, p, index) {
    if (m.connection === 'bot') return botAgentView(m, p, index);
    const online = Boolean(p.online), chatReady = Boolean(p.chatReady);
    return { id: m.name, name: m.name, displayName: m.label || m.name, kind: kindOf(m), order: index,
      description: m.description || '', avatar: m.avatar || null,
      status: chatReady ? 'ready' : online ? 'online' : 'offline', online, chatReady, managementReady: Boolean(p.managementReady),
      capabilities: { ...capabilitiesOf(m), reactions: true, agentReactions: kindOf(m) === 'hermes', busy: nativeUi(m) ? ['queue', 'steer', 'interrupt'] : busyModes({ kind: kindOf(m), native: p.capabilities ? nativeFeatures(p.capabilities) : null }), nativeUi: nativeUi(m), nativeRuns: Boolean(p.capabilities && nativeFeatures(p.capabilities).runs), models: modelsMode(m, p), media: mediaInfo(m) },
      ...(Number.isInteger(p.active_sessions) ? { activeSessions: p.active_sessions } : {}),
      ...(p.lastSeen !== undefined ? { lastSeen: p.lastSeen } : {}),
      checks: { ...Object.fromEntries(Object.entries(p.checks || {}).map(([k, c]) => [k, { ok: Boolean(c?.ok), message: String(c?.message ?? '') }])), media: mediaCheck(m) } };
  }
  /** The "Media" row: can pictures, videos and files from this agent reach the chat? Names versions, never paths. */
  function mediaCheck(m) {
    const i = mediaInfo(m), parts = [`hub ${i.hubVersion}`];
    if (i.connector) { parts.push(i.connector.version ? `connector ${i.connector.version}` : 'connector older than 0.3.5'); if (!i.connector.online) return { ok: false, message: `${parts.join(' · ')} · the machine is offline, so local files cannot be fetched` }; }
    parts.push(i.agent === 'native' ? 'agent: native (media tags, and files its tools make)' : i.agent === 'http' ? 'agent: media tags in replies' : 'agent: media tags in replies');
    return { ok: true, message: parts.join(' · ') };
  }
  // Existing Hermes chats (made before this hub tracked activity, or through another client) live in the agent's own session list. Ask for the newest one, once per
  // minute at most, off the request path, so the next poll of the agent list shows when and what; a failure just means "No messages yet" for now.
  const seeding = new Map();
  function seedFromHermes(ctx, m) {
    const reg = ctx.reg, key = scopeOf(ctx) + '\0' + m.name, tried = seeding.get(key);
    if (tried && Date.now() - tried < 60_000) return; seeding.set(key, Date.now());
    if (seeding.size > 500) seeding.delete(seeding.keys().next().value);
    void (async () => {
      try {
        const data = await upstreamJson(await ctx.reg.upstream.dashboard(m, '/api/sessions?limit=1&order=recent')), row = (Array.isArray(data?.sessions) ? data.sessions : Array.isArray(data) ? data : []).find((r) => r?.id != null);
        if (!row) return void log('activity.seed', { agent: m.name, found: 0 });
        const s = sessionRow(row), text = s.preview || s.title || ''; reg.activity.seed(m.name, { at: s.updated ?? s.started, role: 'assistant', text, title: s.title ?? undefined, session: s.id });
        log('activity.seed', { agent: m.name, found: 1, at: s.updated ?? s.started, fields: Object.keys(row) });
      } catch (e) { log('activity.seed', { agent: m.name, error: e?.status ?? e?.code ?? 'failed' }); }
    })();
  }
  /** The agent-list fields, per user: when, what and which chat was last active, pin state, and whether the agent works or waits for an answer. Never an address. */
  function withActivity(ctx, m, view) {
    const reg = ctx.reg, scope = scopeOf(ctx), a = reg.activity.get(m.name);
    if (!a && kindOf(m) === 'hermes' && m.connection !== 'bot') seedFromHermes(ctx, m); // Hermes keeps its own sessions (native/connector or old /chat path): read them once, in the background
    const pins = reg.activity.pins(), pinIndex = pins.indexOf(m.name);
    const needs = kindOf(m) === 'hermes' && nativeUi(m) && m.machineId ? reg.native.openRequests(scope, m.machineId, m.profile) > 0 : false;
    return { ...view, last_activity_at: a?.at ?? null, last_session_title: a?.title || null, last_message_preview: a?.preview || null, last_role: a?.role ?? null,
      pinned: pinIndex >= 0, pin_order: pinIndex >= 0 ? pinIndex : null, working: runs.working(scope, m.name), needs_input: needs };
  }
  function probeAny(m) {
    if (m.connection === 'bot') return Promise.resolve(bot ? bot.probe(m) : disabledBotProbe(m));
    if (m.machineId && !connectors.isOnline(m.machineId)) return Promise.resolve({ name: m.name, kind: 'hermes', label: m.label, online: false, chatReady: false, managementReady: false, checks: { connector: { ok: false, message: 'Waiting for the machine to connect' } } });
    return upstream.probe(m).then((a) => ({ kind: 'hermes', ...a, ...(m.machineId ? { checks: { connector: { ok: true, message: 'Machine online' }, ...a.checks } } : {}) }));
  }
  function current(m) { if (!store.isCurrent(m)) throw fault(409, 'Connection changed; retry the request'); }
  // GET /api/agents is polled by every open web/Android client, and used to wait for the slowest agent's live probe each time.
  // Now: a result younger than PROBE_TTL_MS is reused as is; otherwise one probe per agent is shared by concurrent requests
  // (single-flight), and once an agent has any result the list waits at most PROBE_WAIT_MS for the fresh one, then answers with
  // the last result marked stale (the probe finishes in the background). Each view carries stale + checked_at (contract/openapi.json).
  // An offline/failed result is kept at most PROBE_FAIL_TTL_MS, and a machine's entries are dropped whenever its connector
  // connects, disconnects or changes profiles (a cached "offline" used to outlive a reconnect, or "online" a disconnect, by 10 s).
  const PROBE_TTL_MS = probeTtlMs, PROBE_FAIL_TTL_MS = 1500, PROBE_WAIT_MS = 1500, probeLast = new Map(), probeFlight = new Map();
  const probeGen = new Map(); // machineId -> bumps on every connector change; a probe that started before one is not stored
  connectors.onChange((machineId) => { probeGen.set(machineId, (probeGen.get(machineId) ?? 0) + 1); for (const [k, r] of probeLast) if (r.machineId === machineId) probeLast.delete(k); });
  function probeShared(m) {
    // Cheap, local answers (bot agents, a machine whose connector is down) are never cached: they must flip at once.
    if (m.connection === 'bot' || (m.machineId && !connectors.isOnline(m.machineId))) return probeAny(m).then((view) => ({ view, stale: false, at: Date.now() }));
    const k = JSON.stringify(m), last = probeLast.get(k);
    if (last && Date.now() - last.at < (last.view?.online ? PROBE_TTL_MS : Math.min(PROBE_TTL_MS, PROBE_FAIL_TTL_MS))) return Promise.resolve({ view: last.view, stale: false, at: last.at });
    let p = probeFlight.get(k);
    if (!p) {
      const gen = probeGen.get(m.machineId);
      p = probeAny(m).then((view) => { const r = { view, at: Date.now(), machineId: m.machineId ?? null }; if (probeGen.get(m.machineId) !== gen) return r; probeLast.delete(k); probeLast.set(k, r); if (probeLast.size > 500) probeLast.delete(probeLast.keys().next().value); return r; }).finally(() => probeFlight.delete(k));
      p.catch((error) => console.warn(`foxfleet: probe of ${m.name} failed: ${error?.message || error}`)); probeFlight.set(k, p);
    }
    const fresh = p.then((r) => ({ view: r.view, stale: false, at: r.at }));
    if (!last) return fresh;
    let timer; const old = new Promise((r) => { timer = setTimeout(() => r({ view: last.view, stale: true, at: last.at }), PROBE_WAIT_MS); timer.unref?.(); });
    return Promise.race([fresh, old]).finally(() => clearTimeout(timer));
  }
  // Which native run controls this Hermes profile advertises (GET /v1/capabilities), cached briefly. Other kinds have none.
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
    const inner = async (item, { rebuild }) => {
      reg.activity.touch(m.name, { role: 'user', text: item.text, session: item.session || undefined });
      const link = {}, mo = item.session ? reg.ledger.modelOf(m.name, item.session) : null; // per-chat model override (models: 'request')
      // A new chat gets its id from the hub, sent to Hermes (session_id on /v1/runs, X-Hermes-Session-Id on chat completions), so the
      // client, the live events and the ledger all know the chat before the first byte. Hermes's own id still wins when it answers with one.
      // Before, a new chat only had an id when Hermes echoed one back: POST /v1/runs answers { run_id, status } and header-less chat
      // completions may echo nothing, so run.started/run.finished carried no chat, message.new was never written and the reply only
      // showed up when the chat was reopened from history.
      const sid = item.session || newChatId();
      if (native?.runs) {
        const content = item.message.content, input = typeof content === 'string' ? content : [{ role: 'user', content }];
        const ctrl = nativeControl({ api: reg.upstream.api, m, link }); link.steer = ctrl.steer; link.stop = ctrl.stop;
        return runs.start({ scope, agent: m.name, session: item.session || undefined, link, timeoutMs, onFinish: undefined,
          open: (signal) => nativeRun({ api: (mm, route, o) => reg.upstream.api(mm, route, o), m, input, sessionId: sid, idempotencyKey: item.id, link, signal, model: mo?.model, provider: mo?.provider, verifySession: !item.session && native.status }),
          check: (r) => { if (link.sessionAdopted) log('run.session', { agent: m.name, adopted: 'hermes' }); return { 'X-Hermes-Session-Id': chatIdOf(r, sid) }; } });
      }
      const messages = rebuild || !item.body ? [item.message] : item.body.messages; // older Hermes keeps its own transcript by session id
      return runs.start({ scope, agent: m.name, session: item.session || undefined, timeoutMs,
        open: (signal) => reg.upstream.api(m, '/v1/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Hermes-Session-Id': sid }, body: JSON.stringify({ model: mo?.model || item.body?.model || 'hermes-agent', ...(mo?.provider ? { provider: mo.provider } : {}), messages, stream: true }) }),
        check: (r) => { if (!r.headers.get('content-type')?.includes('text/event-stream')) throw fault(502, 'Invalid chat stream'); return { 'X-Hermes-Session-Id': chatIdOf(r, sid) }; } });
    };
    return { async launch(item, opts) {
      let run;
      try { run = await inner(item, opts); } catch (e) { try { launchedInLedger(reg, m, item, null, e?.safe ? e.message : 'Could not start the reply'); } catch { /* best effort */ } throw e; }
      try { launchedInLedger(reg, m, item, run, null); } catch { /* best effort */ }
      return run;
    } };
  }
  // ---- notification reply / read (docs/LIVE-EVENTS.md "Notification direct reply") ----
  const replyFlight = new Map(), replyRate = new Map();
  /** Send text into a chat from the hub itself (notification reply): same path as a normal queued send. Returns { message, run_id }. */
  async function sendFromHub(ctx, m, chat, text, source, clientId) {
    const reg = ctx.reg, scope = scopeOf(ctx);
    if (nativeUi(m)) {
      const r = await facade.send(reg.native, { scope, m, session: chat, text, images: [], mode: 'queue', clientId });
      reg.activity.touch(m.name, { role: 'user', text, session: chat });
      const msg = nativeInLedger(reg, m, r, { text, source, mode: 'queue', fresh: false });
      return { message: msg ? reg.ledger.messageAt(m.name, chat, msg.n, text) : null, run_id: r.run?.id ?? null };
    }
    const native = await nativeFor(m);
    const { result, msg } = await submitIndexed(ctx, m, launcher(m, ctx, native), { scope, agent: m.name, session: chat, mode: 'queue', text, message: { role: 'user', content: text }, clientId, modes: ['queue'] }, source);
    return { message: msg ? reg.ledger.messageAt(m.name, chat, msg.n, text) : null, run_id: result.run_id ?? null };
  }
  async function notifyAction(req, res, ctx, action, limit) {
    const reg = ctx.reg, scope = scopeOf(ctx), b = await readJson(req, 256 * 1024);
    const agent = typeof b.agent === 'string' ? b.agent : '', chat = typeof b.chat === 'string' ? b.chat : '';
    if (limit && (agent !== limit.agent || chat !== limit.chat)) throw fault(403, 'This notification action is for another chat', 'reply_token_invalid');
    const m = reg.store.all().find((x) => x.name === agent); if (!m || !validSessionId(chat)) throw fault(404, 'Chat not found', 'chat_not_found');
    if (action === 'read') {
      if (b.up_to !== undefined && !(Number.isInteger(b.up_to) && b.up_to >= 1)) throw fault(400, 'up_to must be a positive whole number', 'invalid_read_position');
      await ensureOr404(reg, m, chat);
      return sendJson(res, 200, reg.ledger.read(agent, chat, b.up_to ?? reg.ledger.lastN(agent, chat)).state);
    }
    const hk = req.headers['idempotency-key'], bk = b.idempotency_key;
    if (hk !== undefined && bk !== undefined && hk !== bk) throw fault(400, 'Idempotency-Key and idempotency_key differ', 'invalid_idempotency_key');
    const key = bk ?? hk; if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) throw fault(400, 'idempotency_key is required: 8-100 characters of A-Z a-z 0-9 _ . : -', 'invalid_idempotency_key');
    if (typeof b.text !== 'string' || !b.text.trim()) throw fault(400, 'Write a reply first');
    if (b.text.length > 32_000) throw fault(413, 'Too long to send from a notification; open the chat', 'text_too_long');
    if (b.mark_read !== undefined && typeof b.mark_read !== 'boolean') throw fault(400, 'mark_read must be true or false');
    const hash = createHash('sha256').update(`${agent}\0${chat}\0${b.text}`).digest('hex'), ik = `${scope}\0${key}`;
    while (replyFlight.has(ik)) await replyFlight.get(ik).catch(() => {}); // the same key in flight: wait for it, then answer as a replay
    const prior = reg.ledger.idem.get(key);
    if (prior) { if (prior.h !== hash) throw fault(409, 'This idempotency key was already used for a different reply', 'idempotency_conflict'); return sendJson(res, 200, { ...prior.result, message: prior.result.message ? { ...prior.result.message, text: clipText(b.text).text } : null, duplicate: true }); }
    const p = (async () => {
      if (m.connection === 'bot') throw fault(409, 'Direct reply is not available for this agent; open the chat');
      await ensureOr404(reg, m, chat);
      // The rate-limit slot is taken only by a reply that will really be sent (not a replay, a 409 or a 404).
      const t = Date.now(), win = (replyRate.get(scope) ?? []).filter((x) => x > t - 60_000);
      if (win.length >= replyRatePerMin) throw Object.assign(fault(429, 'Too many replies; try again shortly', 'rate_limited'), { retryAfter: Math.max(1, Math.ceil((win[0] + 60_000 - t) / 1000)) });
      win.push(t); replyRate.set(scope, win); if (replyRate.size > 5000) replyRate.delete(replyRate.keys().next().value);
      if (b.mark_read !== false) reg.ledger.read(agent, chat, reg.ledger.lastN(agent, chat));
      const sent = await sendFromHub(ctx, m, chat, b.text, 'notification', key);
      const message = sent.message ?? { hub_id: null, upstream_id: null, n: 0, role: 'user', ...clipText(b.text), at: Date.now(), source: 'notification', status: 'sent', reply_to: null, edited_at: null, run_id: null };
      const result = { message, session_id: chat, run_id: sent.run_id ?? null, duplicate: false };
      const { text: _omit, truncated: _t, ...stored } = message; reg.ledger.idem.put(key, hash, { ...result, message: stored }); // the text itself is not kept
      return result;
    })();
    replyFlight.set(ik, p);
    try { return sendJson(res, 202, await p); } finally { replyFlight.delete(ik); }
  }
  // Chats written elsewhere (another Hermes client): on a chat-list read, at most once a minute per agent, look at the agent's newest
  // session in the background; new messages arrive as message.new (source external), a brand-new session's replies count as unread.
  const syncing = new Map();
  function syncExternal(ctx, list) {
    const reg = ctx.reg, scope = scopeOf(ctx);
    for (const m of list) {
      if (kindOf(m) !== 'hermes' || m.connection === 'bot' || (m.machineId && !connectors.isOnline(m.machineId))) continue;
      const k = `${scope}\0${m.name}`, last = syncing.get(k); if (last && Date.now() - last < 60_000) continue;
      syncing.set(k, Date.now()); if (syncing.size > 2000) syncing.delete(syncing.keys().next().value);
      void (async () => {
        const data = await upstreamJson(await reg.upstream.dashboard(m, '/api/sessions?limit=1&order=recent')), row = (Array.isArray(data?.sessions) ? data.sessions : Array.isArray(data) ? data : []).find((r) => r?.id != null);
        if (!row) return; const sr = sessionRow(row), chat = sr.id; if (!validSessionId(chat)) return;
        const L = reg.ledger, a = L.ensureAgent(m.name), had = L.has(m.name, chat);
        if (had && (sr.updated ?? 0) <= L.sessionAt(m.name, chat) + 1000) return;
        const msgs = normalizeTranscript((await reg.upstream.messages(m, chat)).messages);
        L.reconcile(m.name, chat, msgs, { unreadNew: !had && (sr.started ?? sr.updated ?? 0) > a.since });
        log('chats.sync', { agent: m.name, known: had });
      })().catch((e) => log('chats.sync', { agent: m.name, error: e?.status ?? e?.code ?? 'failed' }));
    }
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
  /** Refuses an IP that is already over the limit without spending budget (authenticated bot data-plane requests). */
  function authLocked(req) { const a = authFails.get(clientIp(req)); if (a && a.until >= Date.now() && a.count >= 60) throw fault(429, 'Too many requests'); }
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
      const botMediaUpload = req.method === 'POST' && req.url === '/api/bot/media';
      const agentFileUpload = req.method === 'POST' && /^\/api\/agents\/[^/]+\/files$/.test(req.url.split('?')[0]) && /^application\/octet-stream$/i.test(mime || '');
      const upload = botMediaUpload || agentFileUpload;
      if (!upload && (mime || hasBody) && !/^application\/json(?:\s*;|$)/i.test(mime || '')) { req.resume(); throw fault(415, 'Mutations require application/json'); }
    }
  }
  // Open event streams (live v1/v2, notifications, run and native streams): a shutdown ends them, since they never end by themselves.
  const sseOpen = new Set(); let stopping = false;
  const trackSse = (res) => {
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...rest) {
      const h = rest.find((x) => x && typeof x === 'object' && !Array.isArray(x)), type = String((h && (h['Content-Type'] ?? h['content-type'])) ?? res.getHeader('content-type') ?? '');
      if (type.startsWith('text/event-stream')) { if (stopping) setImmediate(() => res.destroy()); else { sseOpen.add(res); res.once('close', () => sseOpen.delete(res)); } }
      return writeHead.call(this, status, ...rest);
    };
  };
  const server = http.createServer((req, res) => als.run({}, async () => {
    const ctx = als.getStore();
    trackSse(res);
    try {
      boundary(req, server);
      const url = new URL(req.url, 'http://hub');
      let parts; try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw fault(400, 'Invalid path'); }
      if (url.pathname === '/api/bot/media' || url.pathname.startsWith('/api/bot/media/')) {
        if (!bot) throw fault(404, 'Not found');
        return await bot.mediaHttp(req, res, { sendJson, throttle: { check: () => authLocked(req), fail: () => authThrottle(req) } });
      }
      if (url.pathname === '/api/bot/rpc') {
        if (!bot || req.method !== 'POST') throw fault(404, 'Not found');
        return await bot.rpc(req, res, { sendJson, throttle: { check: () => authLocked(req), fail: () => authThrottle(req) } });
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/health/stream') { // `foxfleet doctor` uses this to see whether a proxy/tunnel buffers streaming responses: 4 chunks, 400 ms apart, nothing private
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        let n = 0; res.write('retry: 3000\n\n'); const t = setInterval(() => { if (++n >= 4) { clearInterval(t); res.end('data: done\n\n'); } else res.write(`: ${n}\n\n`); }, 400); res.on('close', () => clearInterval(t)); return;
      }
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
      if (req.method === 'GET' && url.pathname === '/api/auth') return sendJson(res, 200, { required: !singleUser, setupRequired: !singleUser && accounts.needsSetup(), setupCodeRequired: Boolean(setupCode), registration: singleUser ? 'closed' : accounts.registration(), termsVersion: TERMS_VERSION, hub: hubInfo, authenticated: Boolean(auth), ...(auth ? { user: auth.user, deviceId: auth.device } : {}) });
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
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'notify' && (parts[2] === 'reply' || parts[2] === 'read') && parts.length === 3) { // notification actions: the session, or a scoped reply token
        let limit = null;
        if (!auth) {
          const tok = req.headers['x-foxfleet-reply-token'];
          if (typeof tok !== 'string' || !tok) throw fault(401, 'Login required');
          const c = tokens.verify(tok), user = c ? accounts.users().find((u) => u.id === c.user) : null;
          const deviceOk = c && user && !user.disabled && accounts.isActive(c.device) && accounts.devices(c.user).some((d) => d.id === c.device);
          if (!deviceOk) { authThrottle(req); throw fault(403, 'This notification action has expired; open the chat in the app', 'reply_token_invalid'); } // never 401: that would sign the app out
          ctx.auth = { user, device: c.device, via: 'reply' }; ctx.reg = await registryFor(user.id, user.role === 'owner'); limit = { agent: c.agent, chat: c.chat };
        }
        return await notifyAction(req, res, ctx, parts[2], limit);
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
        if (route === 'users' && parts.length === 4 && req.method === 'PATCH') { const user = await accounts.setDisabled(auth.user.id, parts[3], Boolean((await body0()).disabled)); if (user.disabled) await bot?.closeScope(user.id); return sendJson(res, 200, { user }); }
        if (route === 'invites' && parts.length === 4 && req.method === 'DELETE') { await accounts.deleteInvite(parts[3]); return sendJson(res, 200, { ok: true }); }
        if (route === 'users' && parts.length === 3 && req.method === 'GET') return sendJson(res, 200, { users: accounts.users() });
        if (route === 'users' && parts.length === 4 && req.method === 'DELETE') { await accounts.removeUser(auth.user.id, parts[3]); await bot?.revokeScope(parts[3]); const removed = registries.get(parts[3]); if (removed) await (await removed).reactions.clear(); return sendJson(res, 200, { ok: true }); }
        throw fault(404, 'Not found');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && parts[0] === 'api' && parts[1] === 'media' && parts.length === 3) return await (parts[2].startsWith('bot.') && bot ? bot.serveMediaToken({ token: parts[2], scope: scopeOf(ctx), req, res }) : media.serve({ token: parts[2], scope: scopeOf(ctx), req, res }));
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
        if (req.method === 'GET') return sendJson(res, 200, { connections: store.all().map(publicAgent) });
        if (req.method === 'POST') {
          const data = await readJson(req);
          if (data?.connection === 'machine' || data?.machineId) throw fault(400, 'Machine agents are added by connecting a machine (Manage > Machines)');
          if (data?.connection === 'bot' && !bot) throw fault(400, 'Invalid connection mode');
          if (data?.connection === 'bot' && !allowBotAgent(String(data?.name ?? ''))) throw fault(403, 'The bot API is not enabled for this agent (FOXFLEET_BOT_AGENTS)');
          const m = await store.add(data?.connection === 'bot' ? { ...data, botId: randomBytes(12).toString('hex') } : data);
          rowChanged(ctx.reg, scopeOf(ctx), m.name); return sendJson(res, 201, { connection: publicAgent(m) });
        }
      }
      if (parts[0] === 'api' && parts[1] === 'live' && parts[2] === 'stream' && parts.length === 3 && req.method === 'GET') { // live chat events (docs/LIVE-EVENTS.md): resumable SSE, 15 s heartbeat
        const device = singleUser ? null : auth.device, v = url.searchParams.get('v');
        if (v !== null && v !== '1' && v !== '2') throw fault(400, 'Unsupported live contract version; use v=1 or v=2', 'unsupported_version');
        if (v === '2') return void attachLive2Stream(req, res, ctx.reg.live2, { cursor: url.searchParams.get('since') ?? url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '', keepAliveMs: Number(process.env.FOXFLEET_LIVE_HEARTBEAT_MS) || undefined, alive: device ? () => accounts.isActive(device) : undefined, counter: ctx.reg.live });
        return void attachLiveStream(req, res, ctx.reg.live, { cursor: url.searchParams.get('after') ?? req.headers['last-event-id'] ?? '', keepAliveMs: Number(process.env.FOXFLEET_LIVE_HEARTBEAT_MS) || undefined, alive: device ? () => accounts.isActive(device) : undefined });
      }
      if (parts[0] === 'api' && parts[1] === 'live' && parts[2] === 'events' && parts.length === 3 && req.method === 'GET') { // live v2 pull: the stream's events as JSON
        const lg = ctx.reg.live2, c = lg.parse(url.searchParams.get('since') ?? '');
        if (c.kind === 'none' || c.kind === 'invalid') throw fault(400, 'since must be a cursor from GET /api/chats or the live stream', 'invalid_cursor');
        if (c.kind !== 'ok') throw Object.assign(fault(410, 'That cursor is no longer available; resync the chat list and chats', 'cursor_expired'), { extra: { cursor: lg.cursor } });
        const { entries, hasMore, expired } = lg.since(c.seq, pageInt(url.searchParams.get('limit'), 1, PULL_MAX, PULL_DEFAULT));
        if (expired) throw Object.assign(fault(410, 'That cursor is no longer available; resync the chat list and chats', 'cursor_expired'), { extra: { cursor: lg.cursor } });
        return sendJson(res, 200, { events: entries.map((e) => JSON.parse(e.line)), cursor: hasMore && entries.length ? `${lg.store}:${entries.at(-1).seq}` : lg.cursor, has_more: hasMore });
      }
      if (parts[0] === 'api' && parts[1] === 'chats') { // chat list, archive, mark unread, read receipts (docs/LIVE-EVENTS.md)
        const L = ctx.reg.ledger, scope = scopeOf(ctx), all = store.all();
        const find = (name) => { const m = all.find((x) => x.name === name); if (!m) throw fault(404, 'Chat not found', 'chat_not_found'); return m; };
        if (parts.length === 2 && req.method === 'GET') {
          for (const m of all) L.ensureAgent(m.name);
          syncExternal(ctx, all);
          const archived = url.searchParams.get('archived') === '1', rows = sortRows(all.map((m) => chatRow(ctx.reg, scope, m)), all.map((m) => m.name));
          return sendJson(res, 200, { chats: rows.filter((r) => r.archived === archived), cursor: ctx.reg.live2.cursor, ...L.totals() });
        }
        if (parts.length === 3 && req.method === 'GET') return sendJson(res, 200, chatRow(ctx.reg, scope, find(parts[2])));
        if (parts.length === 4 && parts[3] === 'archive' && req.method === 'PUT') { const m = find(parts[2]), b = await readJson(req, 512); if (typeof b.archived !== 'boolean') throw fault(400, 'archived must be true or false'); L.setArchived(m.name, b.archived); return sendJson(res, 200, chatRow(ctx.reg, scope, m)); }
        if (parts.length === 4 && parts[3] === 'unread' && req.method === 'PUT') { const m = find(parts[2]), b = await readJson(req, 512); if (typeof b.unread !== 'boolean') throw fault(400, 'unread must be true or false'); L.setManualUnread(m.name, b.unread); return sendJson(res, 200, chatRow(ctx.reg, scope, m)); }
        if (parts.length === 4 && parts[3] === 'read' && req.method === 'POST') {
          const m = find(parts[2]), b = await readJson(req, 1024);
          if (b.all === true) {
            let changed = false; for (const s2 of L.sessions(m.name)) changed = L.read(m.name, s2, L.lastN(m.name, s2)).changed || changed;
            const latest = L.latest(m.name); if (!latest && L.agent(m.name)?.manual) L.setManualUnread(m.name, false);
            return sendJson(res, 200, latest ? L.readState(m.name, latest) : { chat: null, read_up_to: 0, unread_count: 0, agent_unread: 0, total_unread: L.totals().total_unread });
          }
          if (typeof b.chat !== 'string' || !Number.isInteger(b.up_to) || b.up_to < 1) throw fault(400, 'Send { chat, up_to } with a positive whole up_to, or { all: true }', 'invalid_read_position');
          await ensureOr404(ctx.reg, m, b.chat);
          return sendJson(res, 200, L.read(m.name, b.chat, b.up_to).state);
        }
        throw fault(404, 'Not found');
      }
      if (parts[0] === 'api' && parts[1] === 'notify') { // notifications (docs/notifications-api.md): per-account event log, resumable SSE stream, mute
        const nt = ctx.reg.notify, route = parts[2];
        const cursorOf = (v) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : 0); // digits only: '1e3', '0x10', '-5', 'abc' are not cursors
        if (parts.length === 3 && route === 'stream' && req.method === 'GET') {
          // The rotated token (X-Session-Token, apps) is already on `res` here (set at identify time) and survives writeHead: clients must read it from this response too.
          const device = singleUser ? null : auth.device;
          // ?reply=1: reply_finished / approval events carry a reply token minted for this device's stream only (never stored in the log)
          const decorate = url.searchParams.get('reply') === '1' ? (e) => ((e.type === 'reply_finished' || e.type === 'approval') && e.agent && e.chat ? { reply: tokens.mint({ user: auth.user.id, device: device ?? 'local', agent: e.agent, chat: e.chat }) } : null) : null;
          return void attachNotifyStream(req, res, nt, { after: cursorOf(url.searchParams.get('after') ?? req.headers['last-event-id']), keepAliveMs: Number(process.env.FOXFLEET_NOTIFY_HEARTBEAT_MS) || undefined, device, alive: device ? () => accounts.isActive(device) : undefined, decorate });
        }
        if (parts.length === 3 && route === 'events' && req.method === 'GET') {
          const rawSince = url.searchParams.get('since'), rawLimit = url.searchParams.get('limit');
          if (rawSince !== null && !/^\d{1,15}$/.test(rawSince)) throw fault(400, 'since must be a whole number');
          return sendJson(res, 200, nt.since(cursorOf(rawSince ?? '0'), rawLimit !== null && /^\d{1,6}$/.test(rawLimit) ? Number(rawLimit) : undefined));
        }
        if (parts.length === 3 && route === 'prefs' && req.method === 'GET') return sendJson(res, 200, nt.prefs());
        if (parts.length === 3 && route === 'prefs' && req.method === 'PUT') { const b = await readJson(req, 4096); return sendJson(res, 200, await nt.setEnabled(b.enabled)); }
        if (parts.length === 3 && route === 'mute' && req.method === 'PUT') {
          const b = await readJson(req, 4096); if (typeof b.agent !== 'string' || !store.all().some((m) => m.name === b.agent)) throw fault(404, 'Unknown agent');
          const prefs = await nt.setMute({ agent: b.agent, chat: b.chat, muted: b.muted, forMs: b.for_ms }); rowChanged(ctx.reg, scopeOf(ctx), b.agent); return sendJson(res, 200, prefs);
        }
        if (parts.length === 3 && route === 'test' && req.method === 'POST') { await readJson(req, 4096); if (!nt.allowTest()) { res.setHeader('Retry-After', '60'); throw fault(429, 'Too many test notifications; wait a minute'); } return sendJson(res, 200, { event: nt.emit({ type: 'test' }) }); }
        throw fault(404, 'Not found');
      }
      if (parts[0] === 'api' && parts[1] === 'machines') {
        const uid = auth.user.id, view = (m) => machines.publicMachine(m, { online: connectors.isOnline(m.id), ...(connectors.lastSeen(m.id) ? { lastSeen: connectors.lastSeen(m.id) } : {}) });
        if (parts.length === 2 && req.method === 'GET') return sendJson(res, 200, { machines: machines.all(uid).map(view) });
        if (parts.length === 3 && parts[2] === 'pairing' && req.method === 'POST') { const b = await body0(); return sendJson(res, 201, pairingView(req, machines.createPairing(uid, { machineId: typeof b.machineId === 'string' ? b.machineId : undefined }))); }
        if (parts.length === 3 && parts[2] === 'pairing' && req.method === 'GET') { const st = machines.pairingStatus(uid, url.searchParams.get('code')); return sendJson(res, 200, { state: st.state, ...(st.expires ? { expires: st.expires } : {}), ...(st.machine ? { machine: view(machines.get(st.machine.id)) } : {}) }); }
        if (parts.length === 3 && req.method === 'PATCH') { const b = await body0(); return sendJson(res, 200, { machine: view(await machines.rename(uid, parts[2], b.name)) }); }
        if (parts.length === 3 && req.method === 'DELETE') { // revoke: token gone, link dropped, its agents removed
          const m = await machines.remove(uid, parts[2]); connectors.drop(m.id);
          for (let pass = 0; pass < 2; pass++) { for (const a of store.all().filter((x) => x.machineId === m.id)) { await store.remove(a.name); artifacts.clearAgent(a.name); ctx.reg.ledger.removeAgent(a.name); } await new Promise((r) => setImmediate(r)); } // second pass: a sync that was mid-flight
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
        const draft = validateConnection(data, prior);
        const result = await probeAny(draft);
        return sendJson(res, 200, { checks: agentView(draft, result, 0).checks, ok: Boolean(result.chatReady || result.online) });
      }
      if (parts[0] === 'api' && parts[1] === 'connections' && parts[2]) {
        if (parts.length === 3 && req.method === 'PUT') { const m = await store.edit(parts[2], await readJson(req)); upstream.clear(); artifacts.clearAgent(parts[2]); return sendJson(res, 200, { connection: publicAgent(m) }); }
        if (parts.length === 3 && req.method === 'DELETE') { if (store.get(parts[2]).machineId) throw fault(409, 'This agent comes from a connected machine. Change which profiles it shares with the connector (foxfleet-connector profiles) or remove the machine.'); if (store.get(parts[2]).connection === 'bot') await bot?.removeAgent(store.get(parts[2]), ctx.reg); await store.remove(parts[2]); await ctx.reg.reactions.remove(parts[2]); ctx.reg.ledger.removeAgent(parts[2]); upstream.clear(); artifacts.clearAgent(parts[2]); return sendJson(res, 200, { ok: true }); }
        if (parts.length === 4 && parts[3] === 'test' && req.method === 'POST') { const m = store.get(parts[2]), result = await probeAny(m); current(m); return sendJson(res, 200, { checks: agentView(m, result, 0).checks, capabilities: capabilitiesOf(m) }); }
      }
      if (url.pathname === '/api/agents' && req.method === 'GET') { // Every kind, in registry order (?bridged=1 is accepted for 0.4 clients and ignored).
        const agents = await Promise.all(originalConnections.map(async (m, i) => withActivity(ctx, m, await probeShared(m).then((p) => ({ ...agentView(m, p.view, i), stale: p.stale, checked_at: p.at }))))); originalConnections.forEach(current); return sendJson(res, 200, { agents: sortAgents(agents) }); }
      if (parts[0] === 'api' && parts[1] === 'agents' && parts.length === 3 && req.method === 'GET') { const m = store.get(parts[2]); const view = withActivity(ctx, m, agentView(m, await probeAny(m), originalConnections.indexOf(m))); current(m); return sendJson(res, 200, { agent: view }); }
      if (parts[0] === 'api' && parts[1] === 'agents' && parts[2]) {
        const m = store.get(parts[2]), route = parts[3];
        if (bot && m.connection !== 'bot' && route === 'bot-token' && parts.length === 4 && (req.method === 'POST' || req.method === 'DELETE')) throw fault(409, 'This agent is not a bot');
        // SINGLE CHOKE POINT for bot agents: every agent route of a bot is handled (or refused) here, so nothing can ever reach the
        // dashboard, API server, connector, facade or coordinator for one. Only `pin` (hub-side state) falls through to the shared handler below.
        if (m.connection === 'bot' && !(route === 'pin' && parts.length === 4 && req.method === 'PUT')) {
          if (!bot) throw botDisabled();
          if (route === 'sessions' && parts.length === 6 && parts[5] === 'model') throw fault(409, 'Bot agents set the model with /model', 'models_unsupported');
          return await bot.route({ req, res, url, parts, m, scope: scopeOf(ctx), user: auth.user, reg: ctx.reg, readJson, sendJson, current });
        }
        // Reactions and "delete for me" live beside each account's history. Never accept an actor identity from a request body.
        if (route === 'sessions' && parts.length === 6 && (parts[5] === 'reactions' || parts[5] === 'hidden')) {
          const sid = sessionId(parts[4]);
          let messages;
          try {
            messages = normalizeTranscript((await upstream.messages(m, sid)).messages);
          } catch (e) { if (e.status === 404) await ctx.reg.reactions.remove(m.name, sid); throw e; }
          current(m);
          const L = ctx.reg.ledger, inTranscript = (id) => messages.some(x => x.id != null && String(x.id) === id);
          try { L.reconcile(m.name, sid, messages); } catch { /* the snapshot is still served */ } // binds upstream ids to hub ids (message.edited for the apps)
          const actor = { id: 'user:' + scopeOf(ctx), name: auth?.user?.username || 'You', kind: 'human' };
          let changed, change = null, ref = null, target = null;
          if (req.method === 'PUT' || req.method === 'DELETE') {
            const b = await readJson(req, 2048);
            if (parts[5] === 'hidden') {
              if (typeof b.message_id !== 'string' || !b.message_id || b.message_id.length > 200) throw fault(400, 'Invalid message ID', 'invalid_message_id');
              // 0.4.1: the agent's own id or the message's hub id, like reactions
              const hr = L.resolve(m.name, sid, b.message_id), known = inTranscript(b.message_id);
              if (!hr && !known) throw fault(404, 'Message not found', 'message_not_found');
              const u = hr?.u ?? (known ? b.message_id : null), keys = [...new Set([u, hr?.hub_id].filter(Boolean))];
              await ctx.reg.reactions.hide(m.name, sid, keys, req.method === 'PUT');
              try { const copy = u != null ? messages.find((x) => x.id != null && String(x.id) === u) : null; L.hide(m.name, sid, hr?.hub_id ?? b.message_id, req.method === 'PUT', copy ? copy.content ?? '' : undefined); } catch { /* best effort */ }
            } else {
              if (typeof b.message_id !== 'string' || !b.message_id || b.message_id.length > 200) throw fault(400, 'Invalid message ID', 'invalid_message_id');
              // 0.4.1: the agent's own id (as before) or the hub id of a message this chat has (live v2, history)
              ref = L.resolve(m.name, sid, b.message_id); target = b.message_id; const known = inTranscript(b.message_id);
              if (!ref && !known) throw fault(404, 'Message not found', 'message_not_found');
              const keys = [...new Set([ref?.u ?? (known ? b.message_id : null), ref?.hub_id].filter(Boolean))];
              changed = await ctx.reg.reactions.set(m.name, sid, keys, b.emoji, actor, req.method === 'PUT');
              if (changed) change = { emoji: b.emoji, present: req.method === 'PUT', actor };
            }
          } else if (req.method !== 'GET') throw fault(405, 'Method not allowed');
          await announceDerived(ctx.reg, m, sid, messages);
          const ids = new Set(messages.map(x => String(x.id))), view = reactionsOf(ctx.reg, m, sid, messages);
          if (change && ref) reactionEvent(ctx.reg, m.name, sid, ref, view.by_hub_id[ref.hub_id] ?? [], change);
          // PUT/DELETE: the message this call targeted is always in the answer, [] when it has no reactions left ("removed" vs "never had any")
          if (ref) view.by_hub_id[ref.hub_id] ??= [];
          if (ref?.u ? ids.has(ref.u) : false) view.messages[ref.u] ??= []; else if (!ref && changed !== undefined && inTranscript(target)) view.messages[target] ??= [];
          // hidden: upstream ids still in the transcript (as before; a hub-id entry counts once its upstream id is known); hidden_hub_ids (0.4.1): every hidden message by hub id
          const hiddenUp = new Set(), hiddenHub = new Set();
          for (const id of ctx.reg.reactions.hidden(m.name, sid)) { const hr = L.resolve(m.name, sid, id); const u = hr?.u ?? id; if (ids.has(u)) hiddenUp.add(u); if (hr) hiddenHub.add(hr.hub_id); }
          return sendJson(res, 200, { actor, messages: view.messages, by_hub_id: view.by_hub_id, hidden: [...hiddenUp], hidden_hub_ids: [...hiddenHub], ...(changed === undefined ? {} : { changed }) });
        }
        if (url.searchParams.has('profile') && url.searchParams.get('profile') !== m.profile) throw fault(400, 'Use the saved connection profile');
        if (route === 'pin' && parts.length === 4 && req.method === 'PUT') { // pin or unpin for THIS user; pinned agents stay on top in the order they were pinned
          const b = await readJson(req, 512); if (typeof b?.pinned !== 'boolean') throw fault(400, 'pinned must be true or false');
          const pins = await ctx.reg.activity.pin(m.name, b.pinned); rowChanged(ctx.reg, scopeOf(ctx), m.name); return sendJson(res, 200, { pinned: pins.includes(m.name), pins });
        }
        if (route === 'media' && parts.length === 4 && req.method === 'POST') { // a ref the agent mentioned in a reply -> a short-lived link for THIS user
          const b = await readJson(req, 8192), scope = scopeOf(ctx); for (const t of runs.texts(scope, m.name)) media.note(scope, m.name, t);
          return sendJson(res, 200, media.resolve({ scope, agent: m.name, machineId: m.machineId, profile: m.profile, ref: b?.ref }));
        }
        if (route === 'models' && parts.length === 4 && req.method === 'GET') { // one model list for every agent kind (0.4.1): native gateway or the API server's /api/model/options
          const mode = modelsMode(m, nativeUi(m) ? null : (await probeShared(m)).view), refresh = url.searchParams.get('refresh') === '1', sid = url.searchParams.get('session_id') || '';
          if (mode === 'none') throw fault(409, 'This agent offers no model list', 'models_unsupported');
          let providers;
          if (mode === 'native') providers = providersOf(await ctx.reg.native.ui(m.machineId).call(m.profile, 'models', { refresh }));
          else {
            const r = await ctx.reg.upstream.api(m, `/api/model/options${refresh ? '?refresh=1' : ''}`);
            if (r.status === 404 || r.status === 405) { await r.body?.cancel(); throw fault(409, 'This agent is too old to list its models', 'models_unsupported'); }
            const d = await upstreamJson(r); if (!d || typeof d !== 'object' || (d.providers !== undefined && !Array.isArray(d.providers))) throw fault(502, 'Invalid agent response', 'upstream_error');
            providers = providersOf(d);
          }
          current(m);
          const override = mode === 'request' && validSessionId(sid) ? ctx.reg.ledger.modelOf(m.name, sid) : null;
          return sendJson(res, 200, { mode, providers, ...(override ? { override } : {}) });
        }
        if (route === 'sessions' && parts.length === 6 && parts[5] === 'model' && req.method === 'POST') { // per-chat model for 'request' agents: kept by the hub, sent with every new run of that chat
          const sid = sessionId(parts[4]), b = await readJson(req, 1024), mode = modelsMode(m, nativeUi(m) ? null : (await probeShared(m)).view);
          if (mode === 'native') throw fault(409, 'This agent changes models through its native gateway (/native/sessions/{id}/model)', 'models_unsupported');
          if (mode !== 'request') throw fault(409, 'This agent offers no model list', 'models_unsupported');
          if (b.model === null || b.model === '') { ctx.reg.ledger.setModel(m.name, sid, null); return sendJson(res, 200, { session_id: sid, model: null, provider: null }); }
          if (typeof b.model !== 'string' || !/^[\w.:/@+-]{1,200}$/.test(b.model)) throw fault(400, 'model must be a model id from GET /api/agents/{name}/models, or null to use the agent default', 'invalid_model');
          if (b.provider != null && (typeof b.provider !== 'string' || !/^[\w.:-]{1,64}$/.test(b.provider))) throw fault(400, 'provider must be a provider slug from GET /api/agents/{name}/models', 'invalid_model');
          const v = ctx.reg.ledger.setModel(m.name, sid, { model: b.model, provider: b.provider || null });
          current(m); return sendJson(res, 200, { session_id: sid, model: v.model, provider: v.provider });
        }
        if (route === 'native') { // native Hermes UI gateway (see hermes-ui.js): sessions, journaled sends, shared event stream, approvals/clarifications
          if (kindOf(m) !== 'hermes' || !nativeUi(m)) { if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, { native: false }); throw fault(409, 'This agent has no native Hermes gateway; use the standard chat'); }
          const nat = ctx.reg.native, scope = scopeOf(ctx), mid = m.machineId, prof = m.profile, sidOf = (v) => { if (!/^[\w.:-]{1,120}$/.test(v ?? '')) throw fault(400, 'Invalid session'); return v; };
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, nat.capabilities(mid, prof));
          if (parts.length === 5 && parts[4] === 'sessions' && req.method === 'POST') { await readJson(req); return sendJson(res, 201, await nat.create(scope, mid, prof)); }
          if (parts.length === 5 && parts[4] === 'busy') { // PROFILE-wide Hermes setting (display.busy_input_mode): read freely, change only on explicit confirmation
            if (req.method === 'GET') return sendJson(res, 200, { ...(await nat.busy(scope, mid, prof, 'status')), scope: 'profile' });
            if (req.method === 'POST') { const b = await readJson(req); if (b.confirm !== true) throw fault(400, 'This changes how every chat of this Hermes profile treats messages sent while it works; confirm to continue'); if (!['queue', 'steer', 'interrupt'].includes(b.mode)) throw fault(400, 'Invalid mode'); return sendJson(res, 200, { ...(await nat.busy(scope, mid, prof, b.mode)), scope: 'profile' }); }
          }
          if (parts.length === 5 && parts[4] === 'commands' && req.method === 'GET') {
            const sid = url.searchParams.get('session_id') || '';
            const r = await nat.ui(mid).call(prof, 'catalog', /^[\w.:-]{1,120}$/.test(sid) ? { session_id: sid } : {});
            const live = readLiveCatalog(r);
            return sendJson(res, 200, { source: 'agent', pairs: live.pairs, sub: live.sub, canon: live.canon, commands: live.commands, categories: live.categories, skills: live.skills, skill_count: live.skillCount, ...(live.warning ? { warning: live.warning } : {}) });
          }
          if (parts.length === 5 && parts[4] === 'models' && req.method === 'GET') { const r = await nat.ui(mid).call(prof, 'models', { refresh: url.searchParams.get('refresh') === '1' }); return sendJson(res, 200, { providers: providersOf(r) }); }
          if (parts.length === 7 && parts[4] === 'sessions') {
            const sid = sidOf(parts[5]), what = parts[6];
            if (what === 'attach' && req.method === 'POST') { await readJson(req); return sendJson(res, 200, await nat.attach(scope, mid, prof, sid)); }
            if (what === 'messages' && req.method === 'POST') { const b = await readJson(req, LIMITS.chat); if (b.client_id !== undefined && !/^[\w.:-]{8,100}$/.test(String(b.client_id))) throw fault(400, 'Invalid client_id'); const r = await nat.send(scope, mid, prof, sid, { text: b.text, mode: typeof b.mode === 'string' ? b.mode : 'auto', clientId: b.client_id }); return sendJson(res, r.duplicate ? 200 : 202, r); }
            if (what === 'messages' && req.method === 'GET') return sendJson(res, 200, { messages: nat.list(scope, prof, sid) });
            if (what === 'interrupt' && req.method === 'POST') { await readJson(req); return sendJson(res, 200, await nat.interrupt(scope, mid, prof, sid)); }
            if (what === 'model' && req.method === 'POST') { const b = await readJson(req); return sendJson(res, 200, await nat.setModel(scope, mid, prof, sid, b.model, b.confirm === true)); }
            if (what === 'events' && req.method === 'GET') { // SSE: hub cursor, replay + live, any number of viewers
              const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0), n = Number.isInteger(after) && after > 0 ? after : 0;
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write('retry: 3000\n\n');
              const write = (e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
              const f = nat.follow(scope, mid, prof, sid, n, write); if (f.truncated) res.write(`event: foxfleet.gap\ndata: ${JSON.stringify({ cursor: f.cursor })}\n\n`); for (const e of f.events) write(e);
              const ka = setInterval(() => res.write(': keep-alive\n\n'), 15_000); ka.unref?.(); res.once('close', () => { clearInterval(ka); f.unsubscribe(); }); return;
            }
          }
          if (parts.length === 8 && parts[4] === 'sessions' && parts[6] === 'requests' && req.method === 'POST') { const b = await readJson(req); return sendJson(res, 200, await nat.respond(scope, mid, prof, sidOf(parts[5]), parts[7], { result: b.result, error: b.error })); }
          throw fault(404, 'Not found');
        }
        if (route === 'commands' && parts.length === 4 && req.method === 'GET') { // bundled registry, intersected with what this agent can run. A live gateway adds its skills and any names it discovered; those names stay non-executable until a handler exists.
          const native = await nativeFor(m), modes = nativeUi(m) ? ['queue', 'steer', 'interrupt'] : busyModes({ kind: kindOf(m), native });
          let live = null;
          if (nativeUi(m)) {
            try {
              const stored = url.searchParams.get('session') || '';
              const rt = stored ? ctx.reg.native.runtimeOf(m.machineId, m.profile, stored) : '';
              live = readLiveCatalog(await ctx.reg.native.ui(m.machineId).call(m.profile, 'catalog', rt ? { session_id: rt } : {}));
            } catch { live = null; }
          }
          const base = catalogFor({ kind: kindOf(m), bundled: HERMES_COMMANDS.commands, modes });
          const merged = live ? applyLive(base, live) : { commands: base, skills: [], warning: '' };
          return sendJson(res, 200, { source: live ? 'agent' : kindOf(m) === 'hermes' ? 'bundled' : 'local', busy: modes, ...(nativeUi(m) ? { native: true } : {}), commands: merged.commands, ...(merged.skills.length ? { skills: merged.skills } : {}), ...(merged.warning ? { warning: merged.warning } : {}) });
        }
        if (route === 'queue' && nativeUi(m)) { // native sessions: Hermes holds the queue; the hub only reports what it was told and what Hermes still has
          const session = url.searchParams.get('session_id') || '';
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, await facade.queue(ctx.reg.native, { scope: scopeOf(ctx), m, session }));
          if (parts.length === 5 && parts[4] === 'resume' && req.method === 'POST') { await readJson(req); return sendJson(res, 200, await facade.queue(ctx.reg.native, { scope: scopeOf(ctx), m, session })); }
          if (parts.length === 5 && req.method === 'DELETE') throw fault(409, 'Hermes owns this queue: a queued message cannot be taken back from here');
          throw fault(404, 'Not found');
        }
        if (route === 'queue' && kindOf(m) === 'hermes') { // the hub-side message queue of one conversation
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
          const given = /^[\w.:-]{1,120}$/.test(data.session_id ?? ''); if (given) await ensureIndexed(ctx.reg, m, data.session_id).catch(() => {});
          const images = userImages(flat), r = await facade.send(ctx.reg.native, { scope: scopeOf(ctx), m, session: data.session_id, text: images.length ? (flat.text.trim() || 'Look at the attached image.') : text, images, mode: typeof data.mode === 'string' ? data.mode : 'queue', clientId: data.client_id }); ctx.reg.activity.touch(m.name, { role: 'user', text, session: data.session_id });
          if (!r.duplicate) nativeInLedger(ctx.reg, m, r, { text, source: sourceOf(ctx), mode: typeof data.mode === 'string' ? data.mode : 'queue', fresh: !given });
          return sendJson(res, r.duplicate ? 200 : 202, { message: viewOf(r.message), session_id: r.stored, ...(r.run ? { run_id: r.run.id } : {}) });
        }
        if (route === 'messages' && parts.length === 4 && req.method === 'POST' && kindOf(m) === 'hermes') {
          // Send while the agent may be busy. Persisted + acknowledged first; follow the reply through /runs/{id}/events.
          const data = await readJson(req, LIMITS.chat), payload = chatBody(data); current(m);
          const native = await nativeFor(m), modes = busyModes({ kind: kindOf(m), native });
          const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'); if (!lastUser) throw fault(400, 'No user message');
          const flat = flattenContent(lastUser.content), text = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
          const mode = typeof data.mode === 'string' ? data.mode : 'queue';
          if (data.client_id !== undefined && !/^[\w.:-]{8,100}$/.test(String(data.client_id))) throw fault(400, 'Invalid client_id');
          const { result } = await submitIndexed(ctx, m, launcher(m, ctx, native), { scope: scopeOf(ctx), agent: m.name, session: validSessionId(data.session_id) ? data.session_id : '', mode, text, message: { role: 'user', content: lastUser.content }, body: payload, clientId: data.client_id, modes }, sourceOf(ctx));
          return sendJson(res, result.duplicate ? 200 : 202, result);
        }
        if (route === 'runs') { // resumable chat runs: list, follow from a cursor, stop. A run outlives its client connection.
          const scope = scopeOf(ctx);
          if (parts.length === 4 && req.method === 'GET') return sendJson(res, 200, { runs: runs.list(scope, m.name, url.searchParams.get('session_id') || undefined) });
          if (parts.length === 6 && parts[5] === 'events' && req.method === 'GET') { const r = runs.get(scope, m.name, parts[4]), after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0); return runs.attach(req, res, r, Number.isInteger(after) && after > 0 ? after : 0); }
          if (parts.length === 6 && parts[5] === 'stop' && req.method === 'POST') { await readJson(req); const r = runs.get(scope, m.name, parts[4]); const confirmed = await ctx.reg.coord.stop(scope, m.name, r.session || '', r); return sendJson(res, 200, { run: runs.view(r), confirmed }); }
          throw fault(404, 'Not found');
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
          if (m.machineId && !connectors.isOnline(m.machineId)) throw fault(503, 'This agent\'s machine is offline. Start the Foxfleet connector there and try again.', 'machine_offline');
          if (req.method === 'GET' && action === 'status') return sendJson(res, 200, await screens.status(m));
          if (req.method === 'POST' && ['start', 'stop', 'restart', 'observe', 'takeover', 'handback'].includes(action)) { await readJson(req); current(m); return sendJson(res, 200, await screens[action](m)); }
        }
        if (route === 'chat' && parts.length === 4 && req.method === 'POST' && nativeUi(m)) {
          const data = await readJson(req, LIMITS.chat), payload = chatBody(data); current(m);
          const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'), flat = flattenContent(lastUser?.content), userText = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
          const given = /^[\w.:-]{1,120}$/.test(data.session_id ?? ''); if (given) await ensureIndexed(ctx.reg, m, data.session_id).catch(() => {});
          const images = userImages(flat), r = await facade.send(ctx.reg.native, { scope: scopeOf(ctx), m, session: data.session_id, text: images.length ? (flat.text.trim() || 'Look at the attached image.') : userText || '(attachment)', images, mode: 'auto', idleOnly: true }); ctx.reg.activity.touch(m.name, { role: 'user', text: userText || '(attachment)', session: data.session_id });
          nativeInLedger(ctx.reg, m, r, { text: userText || '(attachment)', source: sourceOf(ctx), mode: 'auto', fresh: !given });
          if (!r.run) throw fault(409, 'Hermes did not start a reply for this message; check the conversation');
          return runs.attach(req, res, r.run);
        }
        if (route === 'chat' && parts.length === 4 && req.method === 'POST') {
          const data = await readJson(req, LIMITS.chat), payload = chatBody(data);
          current(m);
          const lastUser = [...payload.messages].reverse().find((x) => x.role === 'user'), flat = flattenContent(lastUser?.content), userText = (flat.text + (flat.images.length ? ' [image]'.repeat(flat.images.length) : '')).trim();
          const { result: res1 } = await submitIndexed(ctx, m, launcher(m, ctx, await nativeFor(m)), { scope: scopeOf(ctx), agent: m.name, session: validSessionId(data.session_id) ? data.session_id : '', mode: 'queue', text: userText || '(attachment)', message: { role: 'user', content: lastUser?.content ?? '' }, body: payload, modes: ['queue'], idleOnly: true }, sourceOf(ctx));
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
          const limit = pageInt(url.searchParams.get('limit'), 1, 200, 80), offset = pageInt(url.searchParams.get('offset'), 0, 100000, 0), sid = sessionId(parts[4]), L = ctx.reg.ledger, rawAfter = url.searchParams.get('after_n');
          if (rawAfter !== null) { // cache catch-up: messages numbered after n, oldest first (needs the whole transcript to number it)
            if (!/^\d{1,9}$/.test(rawAfter)) throw fault(400, 'after_n must be a whole number');
            const full = normalizeTranscript((await upstream.messages(m, sid)).messages); current(m);
            L.reconcile(m.name, sid, full); L.annotate(m.name, sid, full);
            const after = full.filter((x) => Number.isInteger(x.n) && x.n > Number(rawAfter)), page = after.slice(0, limit);
            for (const x of page) if (x.role === 'assistant') media.note(scopeOf(ctx), m.name, x.content);
            await announceDerived(ctx.reg, m, sid, full);
            return sendJson(res, 200, agentData(m, route, { messages: withReactions(ctx.reg, m, sid, page), offset: 0, limit, has_more: after.length > limit }, originalConnections));
          }
          const raw = (await upstream.messages(m, sid, { limit, offset })).messages;
          const msgs = normalizeTranscript(raw); for (const x of msgs) if (x.role === 'assistant') media.note(scopeOf(ctx), m.name, x.content); // old chats keep their pictures
          if (L.annotate(m.name, sid, msgs) > 0 && (offset === 0 && raw.length < limit ? true : L.mayResync(m.name, sid))) { // some messages are not numbered yet: number the chat (this page if it is the whole chat, else read it once)
            try { const full = offset === 0 && raw.length < limit ? msgs : normalizeTranscript((await upstream.messages(m, sid)).messages); L.reconcile(m.name, sid, full); L.annotate(m.name, sid, msgs); } catch { /* the page is still served */ }
          }
          await announceDerived(ctx.reg, m, sid, msgs);
          return sendJson(res, 200, agentData(m, route, { messages: withReactions(ctx.reg, m, sid, msgs), offset, limit, has_more: raw.length >= limit }, originalConnections));
        }
        if (route === 'sessions' && parts.length === 5 && req.method === 'PATCH') { const b = await readJson(req, 4096); current(m); if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw fault(400, 'Invalid title'); await upstreamJson(await upstream.dashboard(m, '/api/sessions/' + encodeURIComponent(sessionId(parts[4])), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: b.title.trim() }) })); return sendJson(res, 200, { id: parts[4], title: b.title.trim() }); }
        if (route === 'sessions' && parts.length === 5 && req.method === 'DELETE') { current(m); await upstreamJson(await upstream.dashboard(m, '/api/sessions/' + encodeURIComponent(sessionId(parts[4])), { method: 'DELETE' })); await ctx.reg.reactions.remove(m.name, parts[4]); ctx.reg.ledger.removeSession(m.name, parts[4]); return sendJson(res, 200, { ok: true }); }
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
      sendJson(res, error.safe ? error.status : 500, { error: error.safe ? error.message : 'Hub request failed', ...(error.safe && error.code ? { code: error.code } : {}), ...(error.safe && error.extra ? error.extra : {}) }, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
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
      if (url.pathname === '/api/bot/ws') return void (bot ? await bot.upgrade(req, socket, head, { deny, throttle: { check: () => authLocked(req), fail: () => authThrottle(req) } }) : deny(404, 'Not Found'));
      if (url.pathname === '/connector') { // a machine dials out: credential is its machine token in the subprotocol list
        authThrottle(req);
        const token = String(req.headers['sec-websocket-protocol'] || '').split(',').map((v) => v.trim()).find((v) => /^[0-9a-f]{32}\.[\w-]{20,100}$/.test(v));
        const machine = token ? machines.authenticate(token) : null;
        if (!machine) return deny(401, 'Unauthorized');
        await machines.touch(machine.id);
        return void connectors.attach(machine.id, wsAccept(req, socket, { protocol: 'foxfleet.v1' }), { onProfiles: (msg, link) => { machines.touch(machine.id, { os: ['linux', 'darwin', 'win32'].includes(msg.os) ? msg.os : undefined, connectorVersion: typeof msg.version === 'string' && /^[\w.+-]{1,32}$/.test(msg.version) ? msg.version : undefined, connectorFeatures: Array.isArray(msg.features) ? msg.features.filter((f) => typeof f === 'string' && /^\w{1,24}$/.test(f)).slice(0, 12) : undefined }).catch(() => {}); return syncProfiles(machine, msg, link); } });
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
  // Closing the hub writes every account's pending notification events first (the save is debounced), and closes the stores afterwards so a run that
  // finishes late cannot schedule a write into a data directory that may be gone. The close callback fires after both.
  const notifyStores = async () => (await Promise.allSettled([...registries.values()])).filter((x) => x.status === 'fulfilled' && x.value.notify).map((x) => x.value.notify);
  const liveStores = async () => (await Promise.allSettled([...registries.values()])).filter((x) => x.status === 'fulfilled' && x.value.live2).map((x) => x.value);
  const closeHub = server.close;
  server.close = function (cb) {
    clearInterval(typingTimer); typingTimer = null; typingRuns.clear();
    void (async () => { await bot?.close().catch(() => {}); for (const n of await notifyStores()) await n.flush().catch(() => {}); })().finally(() => closeHub.call(this, (err) => { void (async () => { for (const n of await notifyStores()) await n.close({ flush: true }).catch(() => {}); for (const r of await liveStores()) { clearImmediate(r.rowTimer); r.rowTimer = null; await r.ledger.close().catch(() => {}); await r.live2.close().catch(() => {}); } })().finally(() => cb?.(err)); }));
    return this;
  };
  /** Graceful stop (SIGTERM/SIGINT): stop accepting, end every open event stream (clients reconnect and resume by cursor), let other
   *  requests finish for up to `timeoutMs`, then cut what is left. Resolves once the stores are closed, so the live log records a clean
   *  stop and every cursor stays valid after the restart. */
  server.shutdown = ({ timeoutMs = 5000 } = {}) => new Promise((resolve) => {
    stopping = true; let hard = null, tick = null;
    server.close(() => { clearTimeout(hard); clearInterval(tick); resolve(); });
    const sweep = () => { for (const res of [...sseOpen]) { sseOpen.delete(res); res.destroy(); } server.closeIdleConnections(); };
    sweep(); tick = setInterval(sweep, 100); tick.unref?.();
    hard = setTimeout(() => server.closeAllConnections(), timeoutMs); hard.unref?.();
  });
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
    let stopping = false;
    const shutdown = () => { // clean stop within the 10 s Docker / 90 s systemd grace, even with apps connected
      if (stopping) return; stopping = true;
      const timeoutMs = 5000;
      void server.shutdown({ timeoutMs }).then(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref(); });
      setTimeout(() => { console.error('Foxfleet did not stop in time'); process.exit(1); }, timeoutMs + 3000).unref();
    };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  } catch (error) { console.error(error.safe ? error.message : 'Foxfleet could not start'); process.exitCode = 1; }
}
