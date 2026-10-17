import { fault, redact, secretsOf } from './config.js';

export async function boundedBytes(response, limit = 4 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fault(413, 'Response exceeds preview limit'); }
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw fault(413, 'Response exceeds preview limit'); chunks.push(chunk); }
  return Buffer.concat(chunks, size);
}
/** Error codes clients can branch on (docs/API-ERRORS.md): agent_offline, timeout, auth_failed, upstream_error. */
export const coded = (error, code) => Object.assign(error, { code });
export async function upstreamJson(response) {
  if (!response.ok) { await response.body?.cancel(); if ([401, 403].includes(response.status)) throw coded(response.status === 401 ? fault(502, 'The agent did not accept the hub\'s credentials. Check the profile on that computer (foxfleet-connector doctor)') : fault(403, 'Agent request failed'), 'auth_failed'); /* An upstream 401 means the AGENT refused the hub's credentials. It must never reach the client as 401: clients read that as "your login expired" (phone: sign-in screen, web: reload loop). */ throw fault(response.status === 401 ? 502 : [400, 403, 404, 409, 413, 429].includes(response.status) ? response.status : 502, response.status === 401 ? 'The agent did not accept the hub\'s credentials. Check the profile on that computer (foxfleet-connector doctor)' : 'Agent request failed'); }
  try { return JSON.parse((await boundedBytes(response)).toString('utf8')); }
  catch (e) { if (e.safe) throw e; throw coded(fault(502, 'Invalid agent response'), 'upstream_error'); }
}
export function validMessages(data) {
  const rows = Array.isArray(data) ? data : (data?.messages || data?.data);
  if (!Array.isArray(rows) || rows.length > 50000 || !rows.every((m) => m && typeof m === 'object' && ['user', 'assistant', 'tool', 'system', 'function'].includes(m.role) && (typeof m.content === 'string' || m.content === null || Array.isArray(m.content)))) throw fault(502, 'Invalid session transcript');
  return rows;
}
// Machine-mode agents have no address: their traffic goes through loopback forwarders owned by the hub (key machineId:profile).
// Their dashboard/API credentials never reach the hub: the connector reads them from the profile locally and injects them.
export const tunnelPorts = new Map();
export const base = (m, service) => {
  if (m.machineId) { const p = tunnelPorts.get(`${m.machineId}:${m.profile}`); if (!p) throw fault(502, 'The machine is offline'); return `http://127.0.0.1:${p[service === 'dashboard' ? 'dashboard' : 'api']}`; }
  return m[service === 'dashboard' ? 'dashboardUrl' : 'apiServerUrl'] || `http://${m.host.includes(':') ? '[' + m.host + ']' : m.host}:${m[service === 'dashboard' ? 'dashboardPort' : 'apiServerPort']}`;
};
const HISTORY_HEDGE_MS = 1000;
const HISTORY_MESSAGES = { agent_offline: 'The agent is offline', timeout: 'The agent did not answer in time', auth_failed: 'The agent did not accept the hub\'s credentials', upstream_error: 'The agent could not load this chat' };
export function hermesClient(timeoutMs = 5000, { probeTimeoutMs = 2500 } = {}) {
  const jars = new Map();
  const key = (m) => JSON.stringify(m);
  const timed = (signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  async function call(m, service, route, opts = {}) {
    let url; try { url = base(m, service) + route; } catch (e) { throw coded(e, 'agent_offline'); }
    try { return await fetch(url, { ...opts, redirect: 'manual', signal: opts.signal ?? timed() }); }
    catch (e) { // e.name: TimeoutError (our deadline), AbortError (caller gave up), else the agent's port refused / reset
      if (e?.name === 'TimeoutError') throw coded(fault(504, 'The agent did not answer in time'), 'timeout');
      if (e?.name === 'AbortError') throw coded(fault(502, 'Agent request cancelled'), 'aborted');
      throw coded(fault(502, 'Agent unavailable or timed out'), 'agent_offline');
    }
  }
  async function login(m, signal) {
    const response = await call(m, 'dashboard', '/auth/password-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'basic', username: m.dashboardUser, password: m.dashboardPass }), signal });
    if (!response.ok) { await response.body?.cancel(); throw fault(502, 'Dashboard authentication failed'); }
    const jar = (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';')[0]).join('; ');
    jars.set(key(m), jar); await response.body?.cancel();
  }
  function scoped(m, route) { const url = new URL(route, 'http://scope'); url.searchParams.set('profile', m.profile); return url.pathname + url.search; }
  async function dashboard(m, route, opts = {}) {
    const signal = opts.stream ? opts.signal : timed(opts.signal);
    if (!jars.has(key(m)) && m.machineId) jars.set(key(m), '');
    if (!jars.has(key(m))) {
      let authRequired = false;
      try { const status = await upstreamJson(await call(m, 'dashboard', scoped(m, '/api/status'), { signal: timed(opts.signal) })); authRequired = status?.auth_required === true; }
      catch { /* A management endpoint can remain available without public status. */ }
      if (authRequired) await login(m, timed(opts.signal));
      else jars.set(key(m), '');
    }
    const send = () => call(m, 'dashboard', scoped(m, route), { ...opts, signal, headers: { ...opts.headers, ...(jars.get(key(m)) ? { Cookie: jars.get(key(m)) } : {}) } });
    // Once a session exists, expired cookies get exactly one login and retry.
    let response = await send();
    if (response.status === 401) { await response.body?.cancel(); if (!m.machineId) await login(m, signal); response = await send(); } // machine agents: the connector re-logs-in locally
    return response;
  }
  function api(m, route, opts = {}) {
    const prefix = m.profile === 'default' ? '' : `/p/${encodeURIComponent(m.profile)}`;
    return call(m, 'api', prefix + route, { ...opts, headers: { ...opts.headers, ...(m.apiServerKey ? { Authorization: `Bearer ${m.apiServerKey}` } : {}) } });
  }
  // History: the dashboard and the API server can both serve it. Ask both at once. The dashboard's answer is preferred (it pages
  // with order=latest and carries message ids that reactions/artifacts key on); the API server's answer is used when the
  // dashboard fails, or when the dashboard still hasn't answered HISTORY_HEDGE_MS after the API did. Before, the API was only
  // asked after the dashboard failed: a slow dashboard cost 5 s, two slow paths 10 s, and the reason was dropped.
  async function messages(m, session, page) {
    const route = `/api/sessions/${encodeURIComponent(session)}/messages?inline_images=false` + (page ? `&limit=${page.limit}&offset=${page.offset}&order=latest` : '');
    const stop = new AbortController();
    const attempt = (via, run) => run().then((data) => ({ ok: true, value: { messages: validMessages(data) } }), (e) => ({ ok: false, error: Object.assign(e instanceof Error ? e : new Error(String(e)), { via }) }));
    const dash = attempt('dashboard', async () => upstreamJson(await dashboard(m, route, { signal: stop.signal })));
    const viaApi = attempt('api', async () => upstreamJson(await api(m, route, { signal: timed(stop.signal) })));
    try {
      const first = await Promise.race([dash.then((r) => ({ who: 'dashboard', r })), viaApi.then((r) => ({ who: 'api', r }))]);
      let d, a;
      if (first.who === 'dashboard') { d = first.r; if (d.ok) return d.value; a = await viaApi; if (a.ok) return a.value; }
      else {
        a = first.r;
        if (a.ok) { let timer; d = await Promise.race([dash, new Promise((r) => { timer = setTimeout(() => r(null), HISTORY_HEDGE_MS); })]); clearTimeout(timer); return d?.ok ? d.value : a.value; }
        d = await dash; if (d.ok) return d.value;
      }
      const errors = [d.error, a.error], codes = errors.map((e) => (e?.safe && e.code) || 'upstream_error');
      console.warn(JSON.stringify({ t: new Date().toISOString(), event: 'history.failed', agent: m.name, attempts: errors.map((e, i) => ({ via: e?.via, code: codes[i], status: e?.status ?? null })) }));
      const code = ['agent_offline', 'auth_failed', 'timeout'].find((c) => codes.includes(c)) || 'upstream_error';
      // Both paths answering 404 most likely means the agent has no such session (or a Hermes too old for the route). History keeps
      // its 502, but callers that need to tell "chat gone" apart (notification reply / read) can see it.
      throw Object.assign(coded(fault(code === 'timeout' ? 504 : 502, HISTORY_MESSAGES[code]), code), { notFound: errors.every((e) => e?.status === 404) });
    } finally { stop.abort(); }
  }
  async function probe(m) {
    let status, capabilities;
    const quick = () => AbortSignal.timeout(probeTimeoutMs); // a status probe gives up sooner than a user's request
    const dashboardCheck = async () => {
      try {
        const data = await upstreamJson(await call(m, 'dashboard', scoped(m, '/api/status'), { signal: quick() }));
        if (!data || typeof data.version !== 'string' || data.version.length > 128 || typeof data.gateway_running !== 'boolean' || !Number.isSafeInteger(data.active_sessions) || data.active_sessions < 0) throw fault(502, 'Invalid dashboard status');
        status = { version: data.version, gateway_running: data.gateway_running, active_sessions: data.active_sessions };
        return { ok: true, message: 'Dashboard reachable' };
      } catch { return { ok: false, message: 'Dashboard unavailable or invalid status' }; }
    };
    const managementCheck = async () => {
      try { const data = await upstreamJson(await dashboard(m, '/api/sessions?limit=1', { signal: quick() })); if (!data || !Array.isArray(data.sessions)) throw new Error(); return { ok: true, message: 'Management authenticated' }; }
      catch { return { ok: false, message: 'Management unavailable or authentication failed' }; }
    };
    const apiCheck = async () => {
      try {
        const response = await api(m, '/v1/capabilities', { signal: quick() });
        // Hermes binds a /p/<profile> prefix to that profile's OWN key (the default key is refused there since July 2026): say so.
        if (response.status === 401 && m.profile && m.profile !== 'default') { await response.body?.cancel(); return { ok: false, message: `Chat API refused the key for profile ${m.profile}: Hermes needs that profile's own API_SERVER_KEY (in its profiles/${m.profile}/.env) for /p/${m.profile}/` }; }
        if ([404, 405].includes(response.status)) {
          await response.body?.cancel(); const models = await upstreamJson(await api(m, '/v1/models', { signal: quick() }));
          if (models?.object !== 'list' || !Array.isArray(models.data) || !models.data.length || !models.data.every((model) => typeof model?.id === 'string' && model.id.length > 0)) throw new Error();
          return { ok: true, message: 'Chat API models available; capabilities unsupported' };
        }
        const data = await upstreamJson(response);
        if (data?.object !== 'hermes.api_server.capabilities' || !data.features || Array.isArray(data.features) || typeof data.features !== 'object' || typeof data.features.chat_completions !== 'boolean') throw new Error();
        // Only retain the stable, typed feature surface, never arbitrary upstream extras.
        capabilities = { object: data.object, features: data.features };
        return { ok: data.features.chat_completions, message: data.features.chat_completions ? 'Chat API authenticated' : 'Chat completions unavailable' };
      } catch { return { ok: false, message: 'Chat API unavailable, invalid or authentication failed' }; }
    };
    const [dashboardResult, management, apiResult] = await Promise.all([dashboardCheck(), managementCheck(), apiCheck()]);
    return { name: m.name, host: m.host, profile: m.profile, online: dashboardResult.ok, chatReady: apiResult.ok, managementReady: management.ok, ...status, checks: { dashboard: dashboardResult, management, api: apiResult }, ...(capabilities ? { capabilities } : {}) };
  }
  return { dashboard, api, messages, probe, clear() { jars.clear(); } };
}
export function safeAgentData(data, connections) { return redact(data, connections.flatMap(secretsOf)); }
