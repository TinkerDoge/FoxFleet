import { fault, redact, secretsOf } from './config.js';

export async function boundedBytes(response, limit = 4 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw fault(413, 'Response exceeds preview limit'); }
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw fault(413, 'Response exceeds preview limit'); chunks.push(chunk); }
  return Buffer.concat(chunks, size);
}
export async function upstreamJson(response) {
  if (!response.ok) { await response.body?.cancel(); throw fault([400, 401, 403, 404, 409, 413, 429].includes(response.status) ? response.status : 502, 'Agent request failed'); }
  try { return JSON.parse((await boundedBytes(response)).toString('utf8')); }
  catch (e) { if (e.safe) throw e; throw fault(502, 'Invalid agent response'); }
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
export function hermesClient(timeoutMs = 5000) {
  const jars = new Map();
  const key = (m) => JSON.stringify(m);
  const timed = (signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  async function call(m, service, route, opts = {}) {
    try { return await fetch(base(m, service) + route, { ...opts, redirect: 'manual', signal: opts.signal ?? timed() }); }
    catch { throw fault(502, 'Agent unavailable or timed out'); }
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
  async function messages(m, session, page) {
    const route = `/api/sessions/${encodeURIComponent(session)}/messages?inline_images=false` + (page ? `&limit=${page.limit}&offset=${page.offset}&order=latest` : '');
    let response;
    try { response = await dashboard(m, route); if (response.ok) { const data = await upstreamJson(response); return { messages: validMessages(data) }; } await response.body?.cancel(); }
    catch { /* API has independent authentication and may provide history without a dashboard. */ }
    const data = await upstreamJson(await api(m, route)); return { messages: validMessages(data) };
  }
  async function probe(m) {
    let status, capabilities;
    const dashboardCheck = async () => {
      try {
        const data = await upstreamJson(await call(m, 'dashboard', scoped(m, '/api/status')));
        if (!data || typeof data.version !== 'string' || data.version.length > 128 || typeof data.gateway_running !== 'boolean' || !Number.isSafeInteger(data.active_sessions) || data.active_sessions < 0) throw fault(502, 'Invalid dashboard status');
        status = { version: data.version, gateway_running: data.gateway_running, active_sessions: data.active_sessions };
        return { ok: true, message: 'Dashboard reachable' };
      } catch { return { ok: false, message: 'Dashboard unavailable or invalid status' }; }
    };
    const managementCheck = async () => {
      try { const data = await upstreamJson(await dashboard(m, '/api/sessions?limit=1')); if (!data || !Array.isArray(data.sessions)) throw new Error(); return { ok: true, message: 'Management authenticated' }; }
      catch { return { ok: false, message: 'Management unavailable or authentication failed' }; }
    };
    const apiCheck = async () => {
      try {
        const response = await api(m, '/v1/capabilities');
        if ([404, 405].includes(response.status)) {
          await response.body?.cancel(); const models = await upstreamJson(await api(m, '/v1/models'));
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
