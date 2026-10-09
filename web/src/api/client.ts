import { ApiError, AuthRequiredError, NetworkError, RateLimitedError } from './errors';
import type { AdminUser, AgentSummary, AuthInfo, Device, Invite, Registration, ScreenStatus, ScreenTicket, SessionInfo, Shareable } from './types';
import { parseKinds, parseSaved, parseTest, type AgentKind, type SaveResult, type SavedAgent, type TestResult } from '../lib/registry';
import type { UiMessage } from '../lib/chat';
import { chatMessages } from '../lib/chat';
import type { FileRef } from '../lib/files';
import { SseParser } from '../lib/sse';

type Fetch = typeof fetch;
export interface ClientOptions { base?: string; fetch?: Fetch; timeoutMs?: number }

/** Typed hub client. Cookie session (HttpOnly, set by the hub), so no token handling in JS. */
export function createClient({ base = '', fetch: f = (...a) => fetch(...a), timeoutMs = 15000 }: ClientOptions = {}) {
  async function request<T>(path: string, init: { method?: string; body?: unknown; plain401?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    init.signal?.addEventListener('abort', () => ctrl.abort());
    let res: Response;
    try {
      res = await f(base + path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        credentials: 'same-origin', signal: ctrl.signal,
        headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch { throw new NetworkError(); } finally { clearTimeout(timer); }
    let data: any = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (res.ok) return data as T;
    const message = String(data?.error?.message ?? data?.error ?? data?.detail ?? res.statusText ?? 'Request failed');
    if (res.status === 401 && !init.plain401) throw new AuthRequiredError(message);
    if (res.status === 429) throw new RateLimitedError(message, Number(res.headers.get('retry-after')) || Number(data?.retryAfter) || 60);
    throw new ApiError(res.status, message);
  }
  const normalize = (o: any): AuthInfo => {
    if (typeof o?.required !== 'boolean') throw new ApiError(502, 'Not a Foxfleet hub', 'not_hub');
    return {
    required: o.required, authenticated: Boolean(o?.authenticated), setupRequired: Boolean(o?.setupRequired),
    setupCodeRequired: Boolean(o?.setupCodeRequired), registration: (['closed', 'invite', 'open'].includes(o?.registration) ? o.registration : 'closed') as Registration,
    user: o?.user && typeof o.user.username === 'string' ? { id: String(o.user.id ?? ''), username: o.user.username, role: o.user.role === 'owner' ? 'owner' : 'user' } : undefined,
    };
  };
  return {
    authInfo: async () => normalize(await request('/api/auth', { plain401: true })),
    login: (username: string, password: string) => request<unknown>('/api/auth/login', { body: { username, password, client: 'web' }, plain401: true }),
    setup: (username: string, password: string, setupCode?: string) => request<unknown>('/api/auth/setup', { body: { username, password, setupCode, client: 'web' }, plain401: true }),
    register: (username: string, password: string, invite: string) => request<unknown>('/api/auth/register', { body: { username, password, invite, client: 'web' }, plain401: true }),
    logout: () => request<unknown>('/api/auth/logout', { method: 'POST', body: {}, plain401: true }),
    agents: async (): Promise<AgentSummary[]> => (await request<{ agents?: AgentSummary[] }>('/api/agents')).agents ?? [],

    // ---- devices and security ----
    devices: async (): Promise<Device[]> => ((await request<any>('/api/auth/devices')).devices ?? []).map((d: any): Device => ({ id: String(d.id), name: String(d.name ?? 'Device'), kind: String(d.kind ?? 'web'), created: Number(d.created) || 0, lastSeen: Number(d.lastSeen) || 0, current: d.current === true })),
    revokeDevice: async (id: string): Promise<boolean> => (await request<any>('/api/auth/devices/' + enc(id), { method: 'DELETE' })).signedOut === true,
    logoutAll: () => request<unknown>('/api/auth/logout-all', { body: {} }),
    changePassword: (current: string, next: string) => request<unknown>('/api/auth/password', { body: { current, next }, plain401: true }),

    // ---- admin (owner) ----
    registrationMode: async (): Promise<Registration> => (await request<any>('/api/admin/settings')).registration ?? 'closed',
    setRegistration: (registration: Registration) => request<unknown>('/api/admin/settings', { method: 'PUT', body: { registration } }),
    pairing: async (): Promise<Shareable> => shareable(await request('/api/admin/pairing')),
    invites: async (): Promise<Invite[]> => ((await request<any>('/api/admin/invites')).invites ?? []).map((i: any): Invite => ({ id: String(i.id), created: Number(i.created) || undefined, expires: Number(i.expires) || 0, used: i.used === true })),
    createInvite: async (): Promise<Shareable> => shareable(await request('/api/admin/invites', { body: {} })),
    revokeInvite: (id: string) => request<unknown>('/api/admin/invites/' + enc(id), { method: 'DELETE' }),
    adminUsers: async (): Promise<AdminUser[]> => ((await request<any>('/api/admin/users')).users ?? []).map((u: any): AdminUser => ({ id: String(u.id), username: String(u.username ?? '?'), role: u.role === 'owner' ? 'owner' : 'user', disabled: u.disabled === true })),
    setUserDisabled: (id: string, disabled: boolean) => request<unknown>('/api/admin/users/' + enc(id), { method: 'PATCH', body: { disabled } }),

    // ---- screen takeover ----
    screen: async <T = ScreenStatus>(agent: string, action: 'status' | 'start' | 'observe' | 'takeover' | 'handback', opts: { keepalive?: boolean } = {}): Promise<T> => {
      if (opts.keepalive) { // used while the page is closing: must not wait for a response
        void f(`${base}/api/agents/${enc(agent)}/screen/${action}`, { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
        return {} as T;
      }
      return action === 'status' ? request<T>(`/api/agents/${enc(agent)}/screen/status`) : request<T>(`/api/agents/${enc(agent)}/screen/${action}`, { body: {} });
    },
    screenTicket: async (agent: string): Promise<ScreenTicket> => { const o = await request<any>(`/api/agents/${enc(agent)}/screen/observe`, { body: {} }); return { ticket: String(o.ticket), expiresInMs: Number(o.expiresInMs) || 30000 }; },
    /** ws(s):// URL of the screen relay for a single-use ticket; follows the hub address (or the page origin). */
    screenUrl: (agent: string, ticket: string): string => { const origin = base || location.origin; return `${origin.replace(/^http/, 'ws')}/api/agents/${enc(agent)}/screen/ws?ticket=${enc(ticket)}`; },

    // ---- agent registry (owner) ----
    agentKinds: async (): Promise<AgentKind[]> => parseKinds(await request('/api/agent-kinds')),
    savedAgents: async (): Promise<SavedAgent[]> => ((await request<any>('/api/connections')).connections ?? []).map(parseSaved),
    addAgent: async (fields: object): Promise<SaveResult> => { const o = await request<any>('/api/connections', { body: fields }); return { agent: parseSaved(o.connection), inboxToken: o.inboxToken, bootstrap: o.bootstrap }; },
    editAgent: async (name: string, fields: object): Promise<SaveResult> => ({ agent: parseSaved((await request<any>('/api/connections/' + enc(name), { method: 'PUT', body: fields })).connection) }),
    deleteAgent: (name: string) => request<unknown>('/api/connections/' + enc(name), { method: 'DELETE' }),
    reorderAgents: (names: string[]) => request<unknown>('/api/connections/order', { body: { names } }),
    testAgent: async (fields: object): Promise<TestResult> => parseTest(await request('/api/connections/test', { body: fields })),
    /** New connector bootstrap (the old token stops working at once) or, for inbox agents, a new MCP token. */
    newToken: async (name: string): Promise<{ bootstrap?: string; inboxToken?: string }> => { const o = await request<any>('/api/connections/' + enc(name) + '/token', { body: {} }); return { bootstrap: o.bootstrap, inboxToken: o.inboxToken }; },

    // ---- sessions and skills ----
    sessions: async (agent: string): Promise<SessionInfo[]> => ((await request<any>(`/api/agents/${enc(agent)}/sessions`)).sessions ?? []).filter((s: any) => s?.id).map((s: any) => ({ id: String(s.id), title: typeof s.title === 'string' ? s.title : undefined })),
    messages: async (agent: string, id: string): Promise<UiMessage[]> => ((await request<any>(`/api/agents/${enc(agent)}/sessions/${enc(id)}/messages`)).messages ?? []).map((m: any) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: contentText(m.content) })),
    skills: async (agent: string): Promise<string[]> => { try { const o = await request<any>(`/api/agents/${enc(agent)}/skills`); const a = o.skills ?? o.data ?? []; return [...new Set<string>(a.map((x: any) => (typeof x === 'string' ? x : x?.name)).filter((x: unknown): x is string => typeof x === 'string' && !!x))].slice(0, 200); } catch (e) { if (e instanceof AuthRequiredError) throw e; return []; } },

    /** Streams a reply. Callbacks fire as SSE events arrive; resolves with the session id. */
    chat: async (agent: string, history: UiMessage[], opts: { sessionId?: string; signal?: AbortSignal; onContent: (t: string) => void; onReasoning: (t: string) => void; onTool: (label: string) => void; onSession: (id: string) => void }): Promise<string | undefined> => {
      let res: Response;
      try {
        res = await f(`${base}/api/agents/${enc(agent)}/chat`, { method: 'POST', credentials: 'same-origin', signal: opts.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'hermes-agent', stream: true, ...(opts.sessionId ? { session_id: opts.sessionId } : {}), messages: chatMessages(history) }) });
      } catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new NetworkError(); }
      if (res.status === 401) throw new AuthRequiredError();
      if (!res.ok) { let m = 'Chat failed'; try { const d = await res.json(); m = String(d?.error?.message ?? d?.error ?? m); } catch { /* keep default */ } throw new ApiError(res.status, m); }
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) throw new ApiError(0, 'Invalid reply stream');
      const sid = res.headers.get('x-hermes-session-id') ?? undefined;
      if (sid && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(sid)) opts.onSession(sid);
      const fail = () => new ApiError(0, 'The agent reply failed. Check the agent and try again.');
      const parser = new SseParser((e) => {
        if (e.data === '[DONE]') return false;
        if (e.event === 'error') throw fail();
        let v: any; try { v = JSON.parse(e.data); } catch { return true; }
        if (!v || typeof v !== 'object') return true;
        if ('error' in v) throw fail();
        if (e.event === 'hermes.tool.progress') { opts.onTool(String(v.tool ?? v.name ?? 'tool')); return true; }
        for (const c of Array.isArray(v.choices) ? v.choices : []) {
          const d = c?.delta; if (!d) continue;
          if (typeof d.content === 'string' && d.content) opts.onContent(d.content);
          if (typeof d.reasoning_content === 'string' && d.reasoning_content) opts.onReasoning(d.reasoning_content);
        }
        return true;
      });
      const reader = res.body.getReader(), dec = new TextDecoder(); let more = true;
      while (more) { const { done, value } = await reader.read(); if (done) break; more = parser.push(dec.decode(value, { stream: true })); }
      if (!more) await reader.cancel().catch(() => {}); else parser.end();
      return sid;
    },

    /** Streams a file to the agent's disk with progress (XHR: fetch has no upload progress). */
    uploadFile: (agent: string, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<FileRef> => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${base}/api/agents/${enc(agent)}/files?name=${enc(file.name)}${file.type ? `&type=${enc(file.type)}` : ''}`);
      x.setRequestHeader('Content-Type', 'application/octet-stream'); x.withCredentials = true;
      x.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.min(1, e.loaded / e.total));
      x.onerror = () => reject(new NetworkError()); x.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      x.onload = () => {
        let d: any = null; try { d = JSON.parse(x.responseText); } catch { /* not json */ }
        if (x.status === 401) return reject(new AuthRequiredError());
        if (x.status >= 200 && x.status < 300 && typeof d?.path === 'string') return resolve({ name: String(d.name ?? file.name), path: d.path, size: file.size });
        reject(new ApiError(x.status, String(d?.error?.message ?? d?.error ?? `Upload failed (${x.status})`)));
      };
      signal?.addEventListener('abort', () => x.abort());
      x.send(file);
    }),
  };
}
const enc = encodeURIComponent;
const shareable = (o: any): Shareable => ({ link: String(o?.link ?? ''), hub: o?.hub, id: o?.id, expires: Number(o?.expires) || undefined, rows: Array.isArray(o?.rows) ? o.rows.map(String) : null });
function contentText(c: unknown): string { if (typeof c === 'string') return c; if (Array.isArray(c)) return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(''); return ''; }
export type Client = ReturnType<typeof createClient>;
