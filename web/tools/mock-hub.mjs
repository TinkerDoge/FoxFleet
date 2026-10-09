#!/usr/bin/env node
// Dependency-free mock hub for screenshots and local UI work: node tools/mock-hub.mjs [port]. Generic fixtures only.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.argv[2] || 3099);
let signedIn = false, setupDone = process.env.MOCK_SETUP !== '1';
const field = (key, label, type, o = {}) => ({ key, label, type, required: false, writeOnly: false, advanced: false, ...o });
const kinds = [
  { kind: 'hermes', label: 'Hermes agent', summary: 'An agent on your own machine. It connects out to the hub; no open ports.', planned: false, auth: ['token'], warnings: [], fields: [
    field('name', 'ID', 'text', { required: true }), field('label', 'Display name', 'text'), field('description', 'Description', 'text'),
    field('connection', 'Connection', 'enum', { options: ['connector', 'direct'], default: 'connector', help: 'Connector is outbound-only and needs no public address.' }),
    field('host', 'Address', 'text', { required: true, writeOnly: true, advanced: true, when: { connection: 'direct' } }), field('port', 'Port', 'port', { advanced: true, when: { connection: 'direct' } }),
    field('apiKey', 'API key', 'secret', { writeOnly: true, advanced: true })] },
  { kind: 'openai', label: 'OpenAI-compatible', summary: 'Any chat API that speaks the OpenAI format.', planned: false, auth: ['api_key'], warnings: [], fields: [
    field('name', 'ID', 'text', { required: true }), field('label', 'Display name', 'text'), field('apiKey', 'API key', 'secret', { required: true, writeOnly: true }), field('model', 'Model', 'text', { required: true })] },
  { kind: 'openrouter', label: 'OpenRouter', summary: 'One key, many models.', planned: false, auth: ['api_key'], warnings: [], fields: [
    field('name', 'ID', 'text', { required: true }), field('apiKey', 'API key', 'secret', { required: true, writeOnly: true }), field('model', 'Model', 'text', { required: true })] },
];
const caps = (o) => ({ chat: true, images: false, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false, ...o });
let saved = [
  { name: 'atlas', kind: 'hermes', label: 'Atlas', description: 'Research and code on the workstation', connection: 'connector', hasHost: false, hasApiKey: true },
  { name: 'nova', kind: 'openrouter', label: 'Nova', hasApiKey: true, model: 'vendor/model-large' },
  { name: 'echo', kind: 'openai', label: 'Echo', hasApiKey: true, model: 'chat-small' },
];
const agentsOut = () => saved.map((s) => ({ id: s.name, name: s.name, displayName: s.label || s.name, kind: s.kind, online: s.name !== 'echo', chatReady: true, managementReady: s.kind === 'hermes', description: s.description || '',
  capabilities: s.kind === 'hermes' ? caps({ images: true, files: true, voice: true, skills: true, screen: true }) : caps({ images: s.name === 'nova' }) }));
const reply = `Here is a quick summary of the **fleet status**.

| Agent | State | Notes |
|---|---|---|
| Atlas | online | indexing the docs |
| Nova | online | idle |
| Echo | offline | needs a new key |

\`\`\`ts
export function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`

- Open the [docs](https://example.com/docs) for setup.
- Images: ![chart](/api/agents/atlas/media/chart.png)
`;
const sessions = { atlas: [{ id: 'sess_a1', title: 'Docs indexing' }, { id: 'sess_a2', title: 'Release notes draft' }] };
const json = (res, code, o, h = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname; const m = req.method;
  if (!p.startsWith('/api/')) {
    let f = path.join(dist, p === '/' ? 'index.html' : p); if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
  }
  if (p === '/api/auth' ) return json(res, 200, { required: true, authenticated: signedIn, setupRequired: !setupDone, setupCodeRequired: false, registration: 'invite', ...(signedIn ? { user: { id: 'u1', username: 'owner1', role: 'owner' } } : {}) });
  if (p === '/api/auth/login' || p === '/api/auth/setup') { signedIn = true; setupDone = true; await body(req); return json(res, 200, { token: 't', user: { id: 'u1', username: 'owner1', role: 'owner' } }); }
  if (p === '/api/auth/logout') { signedIn = false; return json(res, 200, {}); }
  if (p.endsWith('/media/chart.png')) { const png = fs.readFileSync(path.join(dist, 'fox.png')); res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png); }
  if (!signedIn) return json(res, 401, { error: 'Login required' });
  if (p === '/api/agents') return json(res, 200, { agents: agentsOut() });
  if (p === '/api/agent-kinds') return json(res, 200, { kinds });
  if (p === '/api/connections' && m === 'GET') return json(res, 200, { connections: saved });
  if (p === '/api/connections' && m === 'POST') { const b = await body(req); const c = { name: b.name, kind: b.kind, label: b.label || '', hasApiKey: !!b.apiKey, ...(b.connection === 'connector' || !b.connection ? { connection: 'connector' } : {}) }; saved.push(c);
    return json(res, 200, { connection: c, bootstrap: b.kind === 'hermes' ? `Connect this machine to my Foxfleet hub.\n\n1. Download foxfleet-connector.mjs from the hub's /connector.mjs.\n2. Run: node foxfleet-connector.mjs --hub "$HUB" --token fft_EXAMPLE_TOKEN_SHOWN_ONCE\n\nIt only makes an outbound connection; no ports to open.` : undefined }); }
  if (p === '/api/connections/order') { const { names } = await body(req); saved = names.map((n) => saved.find((s) => s.name === n)).filter(Boolean); return json(res, 200, {}); }
  if (p === '/api/connections/test') { await body(req); await new Promise((r) => setTimeout(r, 300)); return json(res, 200, { ok: true, checks: { api: { ok: true, message: 'Reachable' }, connector: { ok: true, message: 'Connected' } } }); }
  const c = /^\/api\/connections\/([^/]+)$/.exec(p);
  if (c && m === 'PUT') { await body(req); return json(res, 200, { connection: saved.find((s) => s.name === decodeURIComponent(c[1])) }); }
  if (c && m === 'DELETE') { saved = saved.filter((s) => s.name !== decodeURIComponent(c[1])); return json(res, 200, {}); }
  const a = /^\/api\/agents\/([^/]+)\/(sessions|skills|chat|files)(?:\/([^/]+)\/messages)?$/.exec(p);
  if (a) {
    const [, agent, what, sid] = a;
    if (what === 'skills') return json(res, 200, { skills: ['review', 'research', 'deploy-notes', 'translate'] });
    if (what === 'sessions' && !sid) return json(res, 200, { sessions: sessions[agent] || [] });
    if (what === 'sessions') return json(res, 200, { messages: [{ role: 'user', content: 'Summarise the fleet.' }, { role: 'assistant', content: reply }] });
    if (what === 'files') { await body(req); return json(res, 200, { name: url.searchParams.get('name'), path: 'uploads/' + url.searchParams.get('name') }); }
    if (what === 'chat') {
      await body(req); res.writeHead(200, { 'content-type': 'text/event-stream', 'x-hermes-session-id': 'sess_new' });
      const send = (d, e) => res.write(`${e ? 'event: ' + e + '\n' : ''}data: ${JSON.stringify(d)}\n\n`); const delta = (x) => ({ choices: [{ delta: x }] });
      send(delta({ reasoning_content: 'Checking each agent’s status first.' })); await new Promise((r) => setTimeout(r, 400));
      send({ tool: 'fleet_status' }, 'hermes.tool.progress');
      const chunks = reply.match(/[^]{1,12}/g); for (const ch of chunks) { await new Promise((r) => setTimeout(r, +(process.env.MOCK_DELAY || 25))); send(delta({ content: ch })); }
      res.write('data: [DONE]\n\n'); return res.end();
    }
  }
  json(res, 404, { error: 'Not found' });
}).listen(port, '127.0.0.1', () => console.log(`mock hub on http://127.0.0.1:${port}`));
