// A mock of ONE Hermes install with several profiles, shaped after the Hermes docs (API server "Multi-profile routing (/p/<profile>/...)",
// "Running many gateways at once", runs API): one shared dashboard that tells profiles apart with ?profile=, and one shared API listener
// (gateway.multiplex_profiles) that serves named profiles under /p/<profile>/... Each profile has its own key, its own sessions and its
// own runs: the default key is refused (401) on a named prefix, an unknown prefix is 404, a run answers only under the profile that made
// it (404 elsewhere). POST /v1/runs answers { run_id, status } WITHOUT the session id (the docs' shape); the id is on GET /v1/runs/{id}.
// Only fake secrets. Options:
//   keys          { profile: key } (default: '<profile>-key')
//   runs          true: advertise the native run API (run_submission, run_events_sse, ...); false: chat completions only
//   sessionHeader false: header-less chat completions get no X-Hermes-Session-Id back (Hermes only echoes the one you send)
//   runSessionInEvents  true: run events carry session_id (the docs do not promise it)
//   runsIgnoreSession  true: POST /v1/runs does not take a session_id it does not know yet: the run goes under a new session of its own
//   runStatus     how GET /v1/runs/{id} answers: 'ok' (with session_id, default) | 'none' (no session_id) | 404 | 500 | 'hang'
//   ids           (profile, n) => session id (default: Hermes style 20261017_101530_<hex>, the same shape for every profile)
import http from 'node:http';

const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
const body = async (req) => { let t = ''; for await (const c of req) t += c; try { return JSON.parse(t || '{}'); } catch { return {}; } };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

export async function profileHermes(t, { profiles = ['default', 'coder'], keys = {}, runs = false, sessionHeader = true, runSessionInEvents = false, ids, replyDelayMs = 20, dashboardReject = [], runsIgnoreSession = false, runStatus = 'ok' } = {}) {
  const key = (p) => keys[p] ?? `${p}-key`, requests = [], store = new Map(), runTable = new Map(); let n = 0, rn = 0;
  for (const p of profiles) store.set(p, new Map());
  const newId = (p) => (ids ? ids(p, ++n) : `20261017_1015${String(30 + (++n % 30)).padStart(2, '0')}_${(n * 2654435761 >>> 0).toString(16).slice(0, 6)}`);
  const sessionOf = (p, id) => { const s = store.get(p); if (!s.has(id)) s.set(id, []); return s.get(id); };
  const reply = (p, text) => `reply from ${p} to: ${text}`;
  const lastUser = (msgs) => { const u = [...(msgs ?? [])].reverse().find((m) => m.role === 'user'); return typeof u?.content === 'string' ? u.content : ''; };

  // Shared dashboard: ?profile= picks the profile (absent = default). Sign-in is per profile, as the connector does it.
  const dash = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mock'), p = u.searchParams.get('profile') || 'default'; requests.push({ service: 'dashboard', method: req.method, path: u.pathname, profile: p });
    if (u.pathname === '/api/status') return json(res, 200, { version: 'fixture-multi', gateway_running: true, active_sessions: store.get(p)?.size ?? 0, auth_required: false });
    if (!store.has(p)) return json(res, 404, { detail: 'unknown profile' });
    if (dashboardReject.includes(p) && u.pathname.startsWith('/api/sessions')) return json(res, 401, { detail: 'profile rejected' });
    if (u.pathname === '/api/sessions') return json(res, 200, { sessions: [...store.get(p).keys()].reverse().map((id) => ({ id, title: id, preview: '' })) });
    const mm = /^\/api\/sessions\/([^/]+)\/messages$/.exec(u.pathname);
    if (mm) { const s = store.get(p).get(decodeURIComponent(mm[1])); return s ? json(res, 200, { messages: s }) : json(res, 404, { detail: 'Session not found' }); }
    return json(res, 404, {});
  });
  // Shared API listener with /p/<profile>/ routing and per-profile keys.
  const api = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://mock'), pm = /^\/p\/([^/]+)(\/.*)$/.exec(u.pathname), p = pm ? decodeURIComponent(pm[1]) : 'default', route = pm ? pm[2] : u.pathname;
    requests.push({ service: 'api', method: req.method, path: u.pathname, profile: p, route, authorized: req.headers.authorization === `Bearer ${key(p)}` });
    if (!store.has(p)) return json(res, 404, { error: 'unknown profile' });
    if (req.headers.authorization !== `Bearer ${key(p)}`) return json(res, 401, { error: 'invalid key for this profile' });
    if (route === '/v1/capabilities') return json(res, 200, { object: 'hermes.api_server.capabilities', features: { chat_completions: true, session_messages: true, ...(runs ? { run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true } : {}) } });
    if (route === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: p === 'default' ? 'hermes-agent' : p, object: 'model' }] });
    const sm = /^\/api\/sessions\/([^/]+)\/messages$/.exec(route);
    if (sm) { const s = store.get(p).get(decodeURIComponent(sm[1])); return s ? json(res, 200, { messages: s }) : json(res, 404, { error: 'Session not found' }); }
    if (route === '/v1/chat/completions' && req.method === 'POST') {
      const b = await body(req), given = req.headers['x-hermes-session-id'], sid = given || newId(p), s = sessionOf(p, sid), text = lastUser(b.messages);
      s.push({ role: 'user', content: text });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...(given || sessionHeader ? { 'X-Hermes-Session-Id': sid } : {}) });
      const out = reply(p, text); for (const w of out.split(' ')) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + ' ' } }] })}\n\n`); await new Promise((r) => setTimeout(r, 2)); }
      s.push({ role: 'assistant', content: out.split(' ').map((w) => w + ' ').join('') }); return res.end('data: [DONE]\n\n');
    }
    if (runs && route === '/v1/runs' && req.method === 'POST') {
      const b = await body(req), sid = (b.session_id && (!runsIgnoreSession || store.get(p).has(b.session_id)) ? b.session_id : null) || newId(p), id = `run_${p}_${++rn}`, text = typeof b.input === 'string' ? b.input : lastUser(b.input);
      Object.assign(requests.at(-1), { sent: b.session_id ?? null, filed: sid });
      const r = { id, profile: p, session: sid, events: [], waiters: new Set(), done: false }; runTable.set(id, r); sessionOf(p, sid).push({ role: 'user', content: text });
      const push = (type, data) => { r.events.push({ type, data: { run_id: id, ...(runSessionInEvents ? { session_id: sid } : {}), ...data } }); for (const w of [...r.waiters]) w(); };
      setTimeout(() => { push('run.started', {}); const out = reply(p, text); push('message.delta', { delta: out }); setTimeout(() => { sessionOf(p, sid).push({ role: 'assistant', content: out }); r.done = true; push('run.completed', { output: out }); }, replyDelayMs); }, 5);
      return json(res, 202, { run_id: id, status: 'started' }); // no session_id: the docs' shape
    }
    const rm = /^\/v1\/runs\/([^/]+)(\/events|\/stop|\/steer)?$/.exec(route);
    if (runs && rm) {
      const r = runTable.get(rm[1]); if (!r || r.profile !== p) return json(res, 404, { error: 'run not found' }); // runs are per-profile scoped
      if (!rm[2]) {
        if (runStatus === 'hang') return void req.on('close', () => {});
        if (typeof runStatus === 'number') return json(res, runStatus, { error: 'status unavailable' });
        return json(res, 200, { object: 'hermes.run', run_id: r.id, status: r.done ? 'completed' : 'running', ...(runStatus === 'none' ? {} : { session_id: r.session }) });
      }
      if (rm[2] !== '/events') return json(res, 202, { status: 'stopping' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); let at = Number(u.searchParams.get('after') || 0), closed = false; res.on('close', () => { closed = true; });
      for (;;) {
        while (at < r.events.length) { const e = r.events[at++]; res.write(`id: ${at}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, event: e.type })}\n\n`); if (/^run\.(completed|failed|cancelled)$/.test(e.type)) return res.end(); }
        if (closed) return; await new Promise((ok) => { const w = () => { r.waiters.delete(w); ok(); }; r.waiters.add(w); res.once('close', w); });
      }
    }
    return json(res, 404, {});
  });
  const dashboardPort = await listen(dash), apiServerPort = await listen(api);
  t.after(async () => { dash.closeAllConnections(); api.closeAllConnections(); await Promise.all([new Promise((r) => dash.close(r)), new Promise((r) => api.close(r))]); });
  return { requests, store, runs: runTable, key, connection: { name: 'fixture', host: '127.0.0.1', dashboardPort, apiServerPort, dashboardUser: 'admin', dashboardPass: 'dashboard-secret', apiServerKey: key('default') } };
}
