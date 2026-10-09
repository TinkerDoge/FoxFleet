#!/usr/bin/env node
// Dependency-free mock hub for screenshots, local UI work and the shared contract test (contract/run.mjs).
//   node tools/mock-hub.mjs [port]      generic fixtures only; serves web/dist too
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { randomBytes } from 'node:crypto'; import { fileURLToPath } from 'node:url';
import { wsAccept } from '../../server/ws.js';
import { qrRows } from '../../server/qr.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const field = (key, label, type, o = {}) => ({ key, label, type, required: false, writeOnly: false, advanced: false, ...o });
const caps = (o) => ({ chat: true, images: false, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false, ...o });
const REPLY = `Here is the **weekly summary** you asked for. Atlas handled most of the load, and Friday was the busiest day.

| Agent | Tokens | Status |
|---|---:|---|
| Atlas | 1.19M | online |
| Nova | 0.74M | online |
| Echo | 0.29M | offline |

I also wrote a small helper so you can rerun it any time:

\`\`\`python
def weekly_tokens(rows):
    totals = {}
    for agent, tokens in rows:
        totals[agent] = totals.get(agent, 0) + tokens
    return dict(sorted(totals.items(), key=lambda kv: -kv[1]))
\`\`\`

![Tokens per day, last 7 days](/api/agents/atlas/media/chart.png)

Next step: rotate Echo's API key, then I can re-run the report. Want me to open a task for it?
`;

export function createMock({ dist = path.join(here, '..', 'dist'), delay = Number(process.env.MOCK_DELAY || 25), setupFirst = process.env.MOCK_SETUP === '1' } = {}) {
  const kinds = [
    { kind: 'hermes', label: 'Hermes agent', summary: 'An agent on your own machine. It connects out to the hub; no open ports.', planned: false, auth: ['token'], warnings: [], fields: [
      field('name', 'ID', 'text', { required: true }), field('label', 'Display name', 'text'), field('description', 'Description', 'text'),
      field('connection', 'Connection', 'enum', { options: ['direct'], default: 'direct', help: 'Advanced: the hub dials the agent. Use Connect a machine for the normal outbound-only setup.' }),
      field('host', 'Address', 'text', { required: true, writeOnly: true, advanced: true, when: { connection: 'direct' } }), field('port', 'Port', 'port', { advanced: true, when: { connection: 'direct' } }),
      field('apiKey', 'API key', 'secret', { writeOnly: true, advanced: true })] },
    { kind: 'openai', label: 'OpenAI-compatible', summary: 'Any chat API that speaks the OpenAI format.', planned: false, auth: ['api_key'], warnings: [], fields: [
      field('name', 'ID', 'text', { required: true }), field('label', 'Display name', 'text'), field('baseUrl', 'Base URL', 'url', { required: true, writeOnly: true }), field('apiKey', 'API key', 'secret', { required: true, writeOnly: true }), field('model', 'Model', 'text', { required: true })] },
    { kind: 'openrouter', label: 'OpenRouter', summary: 'One key, many models.', planned: false, auth: ['api_key'], warnings: [], fields: [
      field('name', 'ID', 'text', { required: true }), field('apiKey', 'API key', 'secret', { required: true, writeOnly: true }), field('model', 'Model', 'text', { required: true })] },
  ];
  let setupDone = !setupFirst, registration = 'invite';
  const sessions = new Map(); // token -> user
  let saved = [
    { name: 'atlas', kind: 'hermes', label: 'Atlas', description: 'Research and code on the workstation', connection: 'machine', hasHost: false },
    { name: 'coder', kind: 'hermes', label: 'Coder', description: 'Reviews and refactors the repos', connection: 'machine', hasHost: false },
    { name: 'research', kind: 'hermes', label: 'Research', description: 'Reads papers and summarises them', connection: 'machine', hasHost: false },
    { name: 'nova', kind: 'openrouter', label: 'Nova', hasApiKey: true, model: 'vendor/model-large' },
    { name: 'echo', kind: 'openai', label: 'Echo', hasApiKey: true, model: 'chat-small', hasBaseUrl: true },
  ];
  const users = [{ id: 'u1', username: 'owner1', role: 'owner', disabled: false, created: Date.now() - 9e8 }, { id: 'u2', username: 'guest1', role: 'user', disabled: false, created: Date.now() - 3e8 }];
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', pairings = new Map();
  let machines = [{ id: 'a'.repeat(32), name: 'Workstation', os: 'linux', online: true, paired: true, created: Date.now() - 864e5, lastSeen: Date.now(), profiles: [{ profile: 'default', agent: 'atlas' }, { profile: 'coder', agent: 'coder' }, { profile: 'research', agent: 'research' }] }];
  const pairingOut = (code, origin) => { const url = `${origin}/c/${code}`; return { code, display: `${code.slice(0, 5)}-${code.slice(5)}`, expires: pairings.get(code).expires, url, link: `foxfleet://pair?hub=${encodeURIComponent(origin)}&code=${code}`, rows: qrRows(url),
    commands: { sh: `curl -fsSL ${url} | sh`, powershell: `irm ${url}.ps1 | iex`, node: `curl -fsSL ${origin}/connector.mjs -o foxfleet-connector.mjs && node foxfleet-connector.mjs pair --hub ${origin} --code ${code}` } }; };
  let invites = [{ id: 'i1', created: Date.now() - 3600e3, expires: Date.now() + 70 * 3600e3, used: false }];
  const devices = [{ id: 'd1', name: 'Desktop browser', kind: 'web', created: Date.now() - 5e8, lastSeen: Date.now() - 1000 }, { id: 'd2', name: 'Phone', kind: 'app', created: Date.now() - 4e8, lastSeen: Date.now() - 36e5 }, { id: 'd3', name: 'Laptop', kind: 'web', created: Date.now() - 2e8, lastSeen: Date.now() - 86400e3 }];
  let lease = null, screenOn = true;
  const agentsOut = () => saved.map((s) => ({ id: s.name, name: s.name, displayName: s.label || s.name, kind: s.kind, online: s.name !== 'echo', chatReady: true, managementReady: s.kind === 'hermes', description: s.description || '',
    capabilities: s.kind === 'hermes' ? caps({ images: true, files: true, voice: true, skills: true, screen: true }) : caps({ images: s.name === 'nova', sessions: false }) }));
  let retention = 90;
  const H = 3600_000, T0 = Date.now();
  const chatSessions = { atlas: [
    { id: 'sess_a1', title: 'Weekly usage summary', updated: T0 - 0.4 * H, messages: 6, preview: 'Atlas handled most of the load, and the cheap model took the rest.' },
    { id: 'sess_a2', title: 'Release notes draft', updated: T0 - 5 * H, messages: 12, preview: 'Draft is ready: highlights, upgrade notes and the known limits.' },
    { id: 'sess_a3', title: 'Docs indexing', updated: T0 - 30 * H, messages: 4, preview: 'Re-indexed 212 pages; 3 broken links were fixed.' },
    { id: 'sess_a4', title: 'Backup check', updated: T0 - 4 * 24 * H, messages: 8, preview: 'Last nightly backup finished in 41 s, 118 MB.' },
  ] };
  const demo = (f) => { const x = path.join(here, '..', '..', 'design', 'demo', f); return fs.existsSync(x) ? x : null; };
  const DESKTOP = process.env.MOCK_DESKTOP === '1' && demo('desktop.bgra');
  const json = (res, code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
  const tokenOf = (req) => (/^Bearer (.+)$/.exec(req.headers.authorization || '') || /foxfleet_session=([^;]+)/.exec(req.headers.cookie || ''))?.[1];
  const tickets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
    if (p === '/health') return json(res, 200, { ok: true });
    if (!p.startsWith('/api/')) {
      let f = path.join(dist, p === '/' ? 'index.html' : p); if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
    }
    const user = sessions.get(tokenOf(req));
    const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, disabled: u.disabled });
    const session = (b) => { const token = randomBytes(12).toString('hex'); sessions.set(token, users[0]); return json(res, 200, { authenticated: true, user: publicUser(users[0]), ...(b.client === 'app' ? { token } : {}) }, { 'set-cookie': `foxfleet_session=${token}; Path=/; HttpOnly; SameSite=Strict` }); };
    if (p === '/api/auth' && m === 'GET') return json(res, 200, { required: true, authenticated: Boolean(user), setupRequired: !setupDone, setupCodeRequired: false, registration, termsVersion: '1.0', ...(user ? { user: publicUser(user) } : {}) });
    if (p === '/api/auth/setup' && m === 'POST') { const b = await body(req); if (setupDone) return json(res, 409, { error: 'Setup already completed' }); setupDone = true; return session(b); }
    if (p === '/api/auth/login' && m === 'POST') { const b = await body(req); if (b.password === 'wrong wrong wrong') return json(res, 401, { error: 'Wrong username or password' }); return session(b); }
    if (p === '/api/auth/register' && m === 'POST') { await body(req); return session({}); }
    if (p === '/api/auth/logout') { sessions.delete(tokenOf(req)); return json(res, 200, { authenticated: false }, { 'set-cookie': 'foxfleet_session=; Path=/; Max-Age=0' }); }
    if (p === '/api/machines/redeem' && m === 'POST') { const b = await body(req), code = String(b.code || '').toUpperCase().replace(/[\s-]/g, ''), pr = pairings.get(code);
      if (!pr || pr.used || pr.expires < Date.now()) return json(res, 403, { error: 'That pairing code is wrong, already used or expired' });
      pr.used = true; const mc = { id: randomBytes(16).toString('hex'), name: pr.machineId ? machines.find((x) => x.id === pr.machineId)?.name ?? 'My machine' : String(b.name || 'My machine'), os: 'linux', online: true, paired: true, created: Date.now(), lastSeen: Date.now(), profiles: [] };
      if (pr.machineId) { const old = machines.find((x) => x.id === pr.machineId); if (old) { old.online = true; pr.result = old.id; return json(res, 200, { machineId: old.id, token: old.id + '.' + randomBytes(24).toString('base64url'), name: old.name }); } }
      machines.push(mc); pr.result = mc.id; setTimeout(() => { mc.profiles = ['default', 'coder', 'research'].map((n) => ({ profile: n, agent: n })); }, Number(process.env.MOCK_PROFILE_DELAY || 1500));
      return json(res, 200, { machineId: mc.id, token: mc.id + '.' + randomBytes(24).toString('base64url'), name: mc.name }); }
    if (!user) return json(res, 401, { error: 'Login required' });
    if (p === '/api/auth/logout-all') { sessions.clear(); return json(res, 200, { authenticated: false }); }
    if (p === '/api/auth/devices' && m === 'GET') return json(res, 200, { devices: devices.map((d, i) => ({ ...d, current: i === 0 })) });
    const dv = /^\/api\/auth\/devices\/([^/]+)$/.exec(p);
    if (dv && m === 'DELETE') { const i = devices.findIndex((d) => d.id === dv[1]); if (i < 0) return json(res, 404, { error: 'Unknown device' }); devices.splice(i, 1); return json(res, 200, { ok: true, signedOut: false }); }
    if (p === '/api/auth/password') { const b = await body(req); return b.current === 'correct horse battery' ? json(res, 200, { ok: true }) : json(res, 403, { error: 'Current password is wrong' }); }
    if (p === '/api/admin/settings') { if (m === 'PUT') registration = (await body(req)).registration; return json(res, 200, { registration }); }
    if (p === '/api/machines' && m === 'GET') return json(res, 200, { machines });
    if (p === '/api/machines/pairing' && m === 'POST') { const b = await body(req); let code = ''; for (const x of randomBytes(10)) code += ALPHA[x % ALPHA.length]; pairings.set(code, { expires: Date.now() + 15 * 60e3, used: false, machineId: b.machineId || null, result: null }); return json(res, 201, pairingOut(code, 'https://hub.example.com')); }
    if (p === '/api/machines/pairing' && m === 'GET') { const pr = pairings.get(String(url.searchParams.get('code') || '').toUpperCase().replace(/[\s-]/g, '')); if (!pr) return json(res, 404, { error: 'Unknown pairing code' }); if (pr.result) return json(res, 200, { state: 'paired', machine: machines.find((x) => x.id === pr.result) }); return json(res, 200, { state: pr.expires < Date.now() ? 'expired' : 'waiting', expires: pr.expires }); }
    { const mm = /^\/api\/machines\/([0-9a-f]{32})(\/token)?$/.exec(p);
      if (mm) { const mc = machines.find((x) => x.id === mm[1]); if (!mc) return json(res, 404, { error: 'Machine not found' });
        if (mm[2] && m === 'POST') { mc.online = false; let code = ''; for (const x of randomBytes(10)) code += ALPHA[x % ALPHA.length]; pairings.set(code, { expires: Date.now() + 15 * 60e3, used: false, machineId: mc.id, result: null }); return json(res, 201, pairingOut(code, 'https://hub.example.com')); }
        if (m === 'PATCH') { const b = await body(req); mc.name = String(b.name); return json(res, 200, { machine: mc }); }
        if (m === 'DELETE') { machines = machines.filter((x) => x !== mc); return json(res, 200, { ok: true }); } } }
    if (p === '/api/admin/pairing') return json(res, 200, { hub: 'https://hub.example.com', link: 'foxfleet://connect?hub=https://hub.example.com', svg: null, rows: qrRows('foxfleet://connect?hub=https://hub.example.com') });
    if (p === '/api/admin/invites' && m === 'GET') return json(res, 200, { invites });
    if (p === '/api/admin/invites' && m === 'POST') { await body(req); const i = { id: randomBytes(4).toString('hex'), created: Date.now(), expires: Date.now() + 72 * 3600e3, used: false }; invites.push(i); return json(res, 201, { id: i.id, expires: i.expires, link: `foxfleet://connect?hub=https://hub.example.com&invite=EXAMPLE${i.id}`, rows: qrRows(`foxfleet://connect?hub=https://hub.example.com&invite=EXAMPLE${i.id}`) }); }
    const iv = /^\/api\/admin\/invites\/([^/]+)$/.exec(p); if (iv && m === 'DELETE') { invites = invites.filter((i) => i.id !== iv[1]); return json(res, 200, { ok: true }); }
    if (p === '/api/admin/users' && m === 'GET') return json(res, 200, { users: users.map(publicUser) });
    const us = /^\/api\/admin\/users\/([^/]+)$/.exec(p);
    if (us && m === 'PATCH') { const b = await body(req), u = users.find((x) => x.id === us[1]); if (!u) return json(res, 404, { error: 'Unknown user' }); if (u.role === 'owner') return json(res, 400, { error: 'The owner cannot be disabled' }); u.disabled = Boolean(b.disabled); return json(res, 200, { user: publicUser(u) }); }
    if (p === '/api/media-proxy') return /^https:/.test(url.searchParams.get('url') || '') ? json(res, 403, { error: 'That address is not allowed' }) : json(res, 400, { error: 'Only https images can be proxied' });
    if (p === '/api/agents') return json(res, 200, { agents: agentsOut() });
    if (p === '/api/history/settings') { if (m === 'PUT') { const b = await body(req); retention = b.retentionDays; } return json(res, 200, { retentionDays: retention }); }
    if (/^\/api\/agents\/[^/]+\/runs$/.test(p)) return json(res, 200, { runs: [] });
    if (p === '/api/agent-kinds') return json(res, 200, { kinds });
    if (p === '/api/connections' && m === 'GET') return json(res, 200, { connections: saved });
    if (p === '/api/connections' && m === 'POST') { const b = await body(req); const c = { name: b.name, kind: b.kind, label: b.label || '', hasApiKey: !!b.apiKey }; saved.push(c);
      return json(res, 201, { connection: c }); }
    if (p === '/api/connections/order') { const { names } = await body(req); saved = names.map((n) => saved.find((s) => s.name === n)).filter(Boolean); return json(res, 200, { order: saved.map((s) => s.name) }); }
    if (p === '/api/connections/test') { await body(req); await new Promise((r) => setTimeout(r, 200)); return json(res, 200, { ok: true, checks: { api: { ok: true, message: 'Reachable' }, connector: { ok: true, message: 'Connected' } } }); }
    const c = /^\/api\/connections\/([^/]+)(\/token)?$/.exec(p);
    if (c && c[2] && m === 'POST') return json(res, 200, { bootstrap: 'Connect this machine to my Foxfleet hub. Token: fft_EXAMPLE_NEW_TOKEN' });
    if (c && m === 'PUT') { await body(req); return json(res, 200, { connection: saved.find((s) => s.name === decodeURIComponent(c[1])) ?? { name: c[1], kind: 'openai' } }); }
    if (c && m === 'DELETE') { saved = saved.filter((s) => s.name !== decodeURIComponent(c[1])); return json(res, 200, { ok: true }); }
    const a = /^\/api\/agents\/([^/]+)\/(sessions|skills|chat|files|media|screen)(?:\/([^/]+))?(?:\/messages)?$/.exec(p);
    if (a) {
      const [, agent, what, sid] = a;
      if (what === 'media') { const f = (sid === 'photo.jpg' ? demo('photo.jpg') : demo('chart.png')) || path.join(dist, 'fox.png'); res.writeHead(200, { 'content-type': f.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }); return res.end(fs.readFileSync(f)); }
      if (what === 'skills') return json(res, 200, { skills: ['review', 'research', 'deploy-notes', 'translate'] });
      if (what === 'sessions' && !sid) { const all = chatSessions[agent] || [], off = Number(url.searchParams.get('offset') || 0), lim = Number(url.searchParams.get('limit') || 30); return json(res, 200, { sessions: all.slice(off, off + lim), total: all.length }); }
      if (what === 'sessions' && (m === 'PATCH' || m === 'DELETE')) { await body(req).catch(() => {}); return json(res, 200, m === 'PATCH' ? { id: sid, title: 'renamed' } : { ok: true }); }
      if (what === 'sessions') return json(res, 200, { has_more: false, messages: [
        { role: 'user', content: 'Can you summarise last week’s agent activity and chart the token usage?', ts: T0 - 0.5 * H },
        { role: 'assistant', content: REPLY, reasoning: 'The user wants a summary and a chart. Pull usage, then format a table.', tools: [{ name: 'usage_report', args: 'days: 7', result: '3 agents, 41 chats, 1.2M tokens', ok: true }, { name: 'render_chart', args: 'kind: bar', result: 'saved chart.png', ok: true }], ts: T0 - 0.45 * H },
      ] });
      if (what === 'files') { await body(req); return json(res, 200, { name: url.searchParams.get('name'), path: 'uploads/' + url.searchParams.get('name') }); }
      if (what === 'screen') {
        await body(req).catch(() => {});
        const view = () => ({ running: screenOn, supported: true, installed: true, geometry: DESKTOP ? '1280x800' : '800x500', blocker: null, lease });
        if (sid === 'status') return json(res, 200, view());
        if (sid === 'start') { screenOn = true; return json(res, 200, view()); }
        if (sid === 'observe') { const ticket = randomBytes(12).toString('hex'); tickets.add(ticket); setTimeout(() => tickets.delete(ticket), 30000); return json(res, 200, { ticket, expiresInMs: 30000, ...view() }); }
        if (sid === 'takeover') { lease = { holder: 'user', epoch: 1 }; return json(res, 200, { lease, autoHandBackAt: Date.now() + 300000 }); }
        if (sid === 'handback') { lease = null; return json(res, 200, { lease }); }
      }
      if (what === 'chat') {
        await body(req); res.writeHead(200, { 'content-type': 'text/event-stream', 'x-hermes-session-id': 'sess_new' });
        const send = (d, e) => res.write(`${e ? 'event: ' + e + '\n' : ''}data: ${JSON.stringify(d)}\n\n`), delta = (x) => ({ choices: [{ delta: x }] });
        send(delta({ reasoning_content: 'Checking each agent’s status first.' })); await new Promise((r) => setTimeout(r, 400));
        send({ tool: 'fleet_status' }, 'hermes.tool.progress');
        for (const ch of REPLY.match(/[^]{1,12}/g)) { await new Promise((r) => setTimeout(r, delay)); send(delta({ content: ch })); }
        res.write('data: [DONE]\n\n'); return res.end();
      }
    }
    json(res, 404, { error: 'Not found' });
  });
  // Fake desktop over RFB 3.8 (no auth) so the noVNC viewer has something to show.
  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://x'); const t = u.searchParams.get('ticket');
    if (!/^\/api\/agents\/[^/]+\/screen\/ws$/.test(u.pathname) || !t || !tickets.delete(t)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const ws = wsAccept(req, socket, req.headers['sec-websocket-protocol'] ? { protocol: 'binary' } : {}); const W = DESKTOP ? 1280 : 800, H = DESKTOP ? 800 : 500; let buf = Buffer.alloc(0), stage = 0, dirty = false, asked = false, px = 400, py = 250, typed = '';
    const frame = () => {
      if (DESKTOP) { const f = Buffer.from(fs.readFileSync(DESKTOP)); for (let y = -9; y <= 9; y++) for (let x = -2; x <= 2; x++) { const o = ((py + y) * W + px + x) * 4; if (o >= 0 && o < f.length - 3) { f[o] = 20; f[o + 1] = 20; f[o + 2] = 20; } } return f; }
      const f = Buffer.alloc(W * H * 4); const put = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; f[o] = b; f[o + 1] = g; f[o + 2] = r; };
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 245 - y / 10, 190 - y / 14, 140 + x / 20);
      const rect = (x0, y0, w, h, r, g, b) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, r, g, b); };
      rect(120, 70, 560, 340, 252, 250, 247); rect(120, 70, 560, 30, 228, 99, 59); for (let i = 0; i < 9; i++) rect(150, 125 + i * 28, 200 + ((i * 97) % 300), 10, 200, 195, 190);
      rect(150, 125 + 9 * 28, 20 + typed.length * 14, 12, 228, 99, 59); rect(0, H - 36, W, 36, 40, 38, 36);
      for (let i = 0; i < 4; i++) rect(14 + i * 52, H - 30, 40, 24, 228, 99, 59); rect(px - 2, py - 8, 4, 16, 20, 20, 20); rect(px - 8, py - 2, 16, 4, 20, 20, 20);
      return f;
    };
    const update = () => { const h = Buffer.alloc(16); h.writeUInt8(0, 0); h.writeUInt16BE(1, 2); h.writeUInt16BE(0, 4); h.writeUInt16BE(0, 6); h.writeUInt16BE(W, 8); h.writeUInt16BE(H, 10); h.writeInt32BE(0, 12); ws.sendBinary(Buffer.concat([h, frame()])); dirty = false; asked = false; };
    ws.sendBinary(Buffer.from('RFB 003.008\n'));
    ws.on('binary', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0) { if (buf.length < 12) return; buf = buf.subarray(12); stage = 1; ws.sendBinary(Buffer.from([1, 1])); }
        else if (stage === 1) { if (buf.length < 1) return; buf = buf.subarray(1); stage = 2; ws.sendBinary(Buffer.alloc(4)); }
        else if (stage === 2) { if (buf.length < 1) return; buf = buf.subarray(1); stage = 3; const name = Buffer.from('Fixture desktop'), h = Buffer.alloc(24 + name.length); h.writeUInt16BE(W, 0); h.writeUInt16BE(H, 2); Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(h, 4); h.writeUInt32BE(name.length, 20); name.copy(h, 24); ws.sendBinary(h); }
        else {
          const type = buf[0]; const need = type === 0 ? 20 : type === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : 99) : type === 3 ? 10 : type === 4 ? 8 : type === 5 ? 6 : type === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : 99) : 1;
          if (buf.length < need) return; const msg = buf.subarray(0, need); buf = buf.subarray(need);
          if (type === 3) { if (!asked && (!msg[1] || dirty)) update(); else asked = true; }
          if (type === 5) { px = msg.readUInt16BE(2); py = msg.readUInt16BE(4); dirty = true; }
          if (type === 4 && msg[1]) { typed += 'x'; dirty = true; }
          if (dirty && asked) update();
        }
      }
    });
  });
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.argv[2] || 3099); createMock().listen(port, '127.0.0.1', () => console.log(`mock hub on http://127.0.0.1:${port}`));
}
