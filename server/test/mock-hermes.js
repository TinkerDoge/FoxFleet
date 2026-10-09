// Mock Hermes agent machine for testing the Foxfleet relay.
// Implements just enough of the real API surface:
//   dashboard (:9119 paths): /api/status (public), /auth/password-login,
//                            /api/sessions, /api/cron/jobs, /api/skills (cookie auth)
//   api server (:8642 paths): /v1/chat/completions (Bearer auth, SSE streaming)
import http from 'node:http';

const DASH_PORT = Number(process.env.MOCK_DASH_PORT || 19119);
const API_PORT = Number(process.env.MOCK_API_PORT || 18642);
const SESSION_COOKIE = 'hermes_session=mock-cookie-123';

const dash = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, obj, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(200, { auth_required: true, auth_providers: ['basic'], version: 'mock-1.0', gateway_running: true, active_sessions: 2 });
  }
  if (req.method === 'POST' && url.pathname === '/auth/password-login') {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      const body = JSON.parse(buf || '{}');
      if (body.username === 'admin' && body.password === 'secret') {
        return json(200, { ok: true, next: '/' }, { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` });
      }
      return json(401, { error: 'Invalid credentials' });
    });
    return;
  }
  const authed = (req.headers.cookie || '').includes('hermes_session=mock-cookie-123');
  if (!authed) return json(401, { error: 'unauthorized' });
  if (url.pathname === '/api/sessions') {
    return json(200, { sessions: [
      { id: 'sess-1', title: 'SandBag feel revision plan', updated_at: '2026-10-07T21:12:00Z' },
      { id: 'sess-2', title: 'Debug Godot head-bob jitter', updated_at: '2026-10-07T18:40:00Z' },
      { id: 'sess-3', title: 'Shopping list for ESP32 sensors', updated_at: '2026-10-06T12:05:00Z' },
    ] });
  }
  if (url.pathname === '/api/sessions/search') {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const all = [
      { id: 'sess-1', title: 'SandBag feel revision plan' },
      { id: 'sess-2', title: 'Debug Godot head-bob jitter' },
      { id: 'sess-3', title: 'Shopping list for ESP32 sensors' },
    ];
    return json(200, { sessions: all.filter((s) => s.title.toLowerCase().includes(q)) });
  }
  if (url.pathname === '/api/cron/jobs') {
    return json(200, { jobs: [
      { id: 'job-1', name: 'Morning briefing', schedule: '0 8 * * *', enabled: true },
      { id: 'job-2', name: 'Nightly repo backup', schedule: '0 2 * * *', enabled: true },
      { id: 'job-3', name: 'Weekly dependency audit', schedule: '0 9 * * 1', enabled: false },
    ] });
  }
  const cronAction = url.pathname.match(/^\/api\/cron\/jobs\/([^/]+)\/(pause|resume|trigger)$/);
  if (req.method === 'POST' && cronAction) {
    return json(200, { ok: true, id: cronAction[1], action: cronAction[2] });
  }
  if (url.pathname === '/api/skills') {
    // Real Hermes dashboards return a bare array here; the relay normalises it.
    return json(200, [
      { name: 'web-search', description: 'Search the public web', enabled: true },
      { name: 'godot-helper', description: 'Godot 4 GDScript assistance', enabled: true },
      { name: 'blender-pipeline', description: 'Blender export automation', enabled: false },
      { name: 'home-lab', description: 'SSH into the homelab boxes', enabled: true },
    ]);
  }
  if (req.method === 'POST' && url.pathname === '/api/skills/toggle') {
    return json(200, { ok: true });
  }
  if (url.pathname === '/api/logs') {
    return json(200, { logs: [
      { level: 'info', msg: 'gateway: session sess-1 resumed', ts: '2026-10-07T21:12:01Z' },
      { level: 'info', msg: 'dashboard: login ok for admin', ts: '2026-10-07T21:11:58Z' },
      { level: 'warn', msg: 'cron: job-3 skipped (disabled)', ts: '2026-10-07T09:00:00Z' },
      { level: 'info', msg: 'memory: checkpoint written (412 entries)', ts: '2026-10-07T08:00:00Z' },
      { level: 'error', msg: 'mcp: tool timeout on blender-pipeline.export', ts: '2026-10-06T22:14:33Z' },
    ] });
  }
  if (url.pathname === '/api/config') {
    return json(200, { config: { model: 'mock-model', profile: 'default' } });
  }
  if (url.pathname === '/api/profiles') {
    return json(200, { profiles: [{ name: 'default', active: true }] });
  }
  return json(404, { error: 'not found' });
});

const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: 'bad key' });
  const msgMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (req.method === 'GET' && msgMatch) {
    return json(200, { messages: [
      { role: 'user', content: 'What did we decide about the feel revision?' },
      { role: 'assistant', content: 'We locked the plan:\n\n1. **R0** — wire the 6-pose hand lib\n2. **R1** — movement feel layer (bob, FOV kick, landing dip)\n3. **R2** — shrink the UI\n\nM9 stays parked until it lands. Want me to start on R0?' },
    ] });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: 'bad key' });
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Hermes-Session-Id': 'mock-sess-9',
      });
      const chunk = (content) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
      const reply = [
        'Hey there! 👋 This is a **demo reply** from the mock agent.\n\n',
        'Here\'s what I can show off:\n\n',
        '- Streaming tokens, one chunk at a time\n',
        '- `inline code` and **bold** text\n\n',
        '```js\nconsole.log("markdown code blocks work");\n```\n\n',
        'Try the tabs up top: **Sessions**, **Cron**, **Skills**, **Logs**, **Config** — they\'re all live against the mock. 🚀',
      ];
      for (const part of reply) res.write(chunk(part));
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  return json(404, { error: 'not found' });
});

dash.listen(DASH_PORT, () => console.log(`mock dashboard on :${DASH_PORT}`));
api.listen(API_PORT, () => console.log(`mock api server on :${API_PORT}`));
