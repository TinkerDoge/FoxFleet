import { ApiError, AuthRequiredError, NetworkError, RateLimitedError } from './errors';
import type { AdminUser, Machine, Pairing, PairingState, AgentSummary, AuthInfo, Device, Invite, Registration, ScreenStatus, ScreenTicket, SessionInfo, SessionPage, HistoryPage, Shareable } from './types';
import { parseKinds, parseSaved, parseTest, type AgentKind, type SaveResult, type SavedAgent, type TestResult } from '../lib/registry';
import type { UiMessage } from '../lib/chat';
import { chatMessages, fromHistory } from '../lib/chat';
import type { FileRef } from '../lib/files';
import { SseParser } from '../lib/sse';
import { BUNDLED_CATALOG, type Catalog } from '../lib/commands';

type Fetch = typeof fetch;
export interface ClientOptions { base?: string; fetch?: Fetch; timeoutMs?: number }

/** Typed hub client. Cookie session (HttpOnly, set by the hub), so no token handling in JS. */

export type SendMode = 'queue' | 'steer' | 'interrupt' | 'auto';
/** What Hermes itself answered to a message sent while it worked. Shown as received, never predicted. */
export type Ack = 'streaming' | 'queued' | 'steered' | 'redirected' | 'rejected';
export interface QueuedMessage { id: string; state: string; mode: SendMode; text: string; error?: string; note?: string; runId?: string; ack?: Ack }
/** A question or approval the agent is waiting on. Answered once, by id. */
export interface OpenRequest { id: string; kind: 'clarify' | 'approval'; questions: { id: string; question: string; choices: string[]; multi: boolean }[]; command?: string; description?: string }
export interface QueueState { items: QueuedMessage[]; recent: QueuedMessage[]; halted: boolean; activeRun: string | null; modes: SendMode[]; openRequests: OpenRequest[]; canCancel: boolean }
export interface SendResult { message: QueuedMessage; runId?: string; sessionId?: string }
const MODES: SendMode[] = ['queue', 'steer', 'interrupt'];
const ACKS = ['streaming', 'queued', 'steered', 'redirected', 'rejected'];
/** Only the two kinds the app can answer become cards; anything else is ignored (the hub already declined it upstream, so nothing waits). */
export const parseRequest = (r: any): OpenRequest | null => {
  const kind = r?.kind; if ((kind !== 'clarify' && kind !== 'approval') || typeof r?.request_id !== 'string' || !/^[\w.:-]{1,100}$/.test(r.request_id)) return null;
  return { id: r.request_id, kind, questions: (Array.isArray(r.questions) ? r.questions : []).slice(0, 6).map((q: any, i: number) => ({ id: String(q?.id ?? `q${i}`), question: String(q?.question ?? '').slice(0, 2000), choices: (Array.isArray(q?.choices) ? q.choices : []).map(String).slice(0, 50), multi: q?.multi_select === true })), ...(r.command ? { command: String(r.command) } : {}), ...(r.description ? { description: String(r.description) } : {}) };
};
export const parseQueued = (m: any): QueuedMessage => ({ id: String(m?.id ?? ''), state: String(m?.state ?? 'queued'), mode: MODES.includes(m?.mode) ? m.mode : 'queue', text: String(m?.text ?? ''), ...(m?.error ? { error: String(m.error) } : {}), ...(m?.note ? { note: String(m.note) } : {}), ...(m?.run_id ? { runId: String(m.run_id) } : {}), ...(ACKS.includes(m?.ack) ? { ack: m.ack as Ack } : {}) });
export const parseQueue = (r: any): QueueState => ({ items: (Array.isArray(r?.items) ? r.items : []).map(parseQueued), recent: (Array.isArray(r?.recent) ? r.recent : []).map(parseQueued), halted: r?.halted === true, activeRun: typeof r?.active_run === 'string' ? r.active_run : null, modes: (Array.isArray(r?.modes) ? r.modes : []).filter((m: unknown): m is SendMode => MODES.includes(m as SendMode)), openRequests: (Array.isArray(r?.open_requests) ? r.open_requests : []).map(parseRequest).filter((x: OpenRequest | null): x is OpenRequest => !!x), canCancel: r?.can_cancel !== false });
export interface StreamOpts { signal?: AbortSignal; onContent: (t: string) => void; onReasoning: (t: string) => void; onTool: (label: string) => void; onSession: (id: string) => void; onRun?: (id: string) => void; onGap?: () => void; onRunState?: (state: string) => void; onRequest?: (r: OpenRequest) => void; onRequestClosed?: (id: string, reason: string) => void; onAck?: (messageId: string, ack: Ack) => void }
export interface RunInfo { id: string; session_id: string | null; state: 'running' | 'stopping' | 'done' | 'error' | 'stopped'; started: number; events: number }
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); });
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
    termsVersion: typeof o?.termsVersion === 'string' ? o.termsVersion : undefined,
    user: o?.user && typeof o.user.username === 'string' ? { id: String(o.user.id ?? ''), username: o.user.username, role: o.user.role === 'owner' ? 'owner' : 'user' } : undefined,
    };
  };
  async function openEvents(agent: string, run: string, after: number, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try { res = await f(`${base}/api/agents/${enc(agent)}/runs/${enc(run)}/events?after=${after}`, { credentials: 'same-origin', signal }); }
    catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new NetworkError(); }
    if (res.status === 401) throw new AuthRequiredError();
    if (!res.ok) throw new ApiError(res.status, 'That reply is no longer available');
    return res;
  }
  /** Reads one SSE response; if the connection breaks (not an abort) before [DONE], reconnects to the run from the last event id. */
  async function pump(agent: string, first: Response, opts: StreamOpts, knownRun?: string, from = 0): Promise<string | undefined> {
    let res = first, run = knownRun, last = from, sid: string | undefined, attempts = 0;
    for (;;) {
      if (res.status === 401) throw new AuthRequiredError();
      if (!res.ok) { let m = 'Chat failed'; try { const d = await res.json(); m = String(d?.error?.message ?? d?.error ?? m); } catch { /* keep default */ } throw new ApiError(res.status, m); }
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) throw new ApiError(0, 'Invalid reply stream');
      sid = res.headers.get('x-hermes-session-id') ?? sid;
      if (sid && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(sid)) opts.onSession(sid);
      const r = res.headers.get('x-foxfleet-run'); if (r && r !== run) { run = r; opts.onRun?.(r); }
      const fail = () => new ApiError(0, 'The agent reply failed. Check the agent and try again.');
      let finished = false, progressed = false;
      const parser = new SseParser((e) => {
        if (e.id && Number(e.id) > last) { last = Number(e.id); progressed = true; }
        if (e.data === '[DONE]') { finished = true; return false; }
        if (e.event === 'foxfleet.gap') { opts.onGap?.(); return true; }
        if (e.event === 'foxfleet.run') { try { const st = JSON.parse(e.data)?.state; if (typeof st === 'string') opts.onRunState?.(st); } catch { /* state is optional */ } finished = true; return false; } // the run was stopped or failed on the hub
        if (e.event === 'foxfleet.request') { try { const r = parseRequest(JSON.parse(e.data)); if (r) opts.onRequest?.(r); } catch { /* ignore a malformed card */ } return true; }
        if (e.event === 'foxfleet.request_closed') { try { const v = JSON.parse(e.data); if (typeof v?.request_id === 'string') opts.onRequestClosed?.(v.request_id, String(v.reason ?? 'closed')); } catch { /* ignore */ } return true; }
        if (e.event === 'foxfleet.ack') { try { const v = JSON.parse(e.data); if (ACKS.includes(v?.ack)) opts.onAck?.(String(v.message_id), v.ack); } catch { /* ignore */ } return true; }
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
      try {
        while (more) { const { done, value } = await reader.read(); if (done) break; more = parser.push(dec.decode(value, { stream: true })); }
        if (!more) await reader.cancel().catch(() => {}); else parser.end();
      } catch (e) { if ((e as Error).name === 'AbortError' || e instanceof ApiError) throw e; /* connection dropped: fall through and resume */ }
      if (finished || !run) return sid;
      if (progressed) attempts = 0;
      if (++attempts > 8) throw new NetworkError();
      await sleep(Math.min(500 * 2 ** (attempts - 1), 8000), opts.signal);
      try { res = await openEvents(agent, run, last, opts.signal); }
      catch (e) { if (e instanceof ApiError) return sid; /* the run expired on the hub: keep what we have */ if ((e as Error).name === 'AbortError') throw e; continue; }
    }
  }

  return {
    authInfo: async () => normalize(await request('/api/auth', { plain401: true })),
    login: (username: string, password: string) => request<unknown>('/api/auth/login', { body: { username, password, client: 'web' }, plain401: true }),
    setup: (username: string, password: string, setupCode?: string, acceptedTerms?: string) => request<unknown>('/api/auth/setup', { body: { username, password, setupCode, acceptedTerms, client: 'web' }, plain401: true }),
    register: (username: string, password: string, invite: string, acceptedTerms?: string) => request<unknown>('/api/auth/register', { body: { username, password, invite, acceptedTerms, client: 'web' }, plain401: true }),
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
    addAgent: async (fields: object): Promise<SaveResult> => { const o = await request<any>('/api/connections', { body: fields }); return { agent: parseSaved(o.connection), inboxToken: o.inboxToken }; },
    editAgent: async (name: string, fields: object): Promise<SaveResult> => ({ agent: parseSaved((await request<any>('/api/connections/' + enc(name), { method: 'PUT', body: fields })).connection) }),
    deleteAgent: (name: string) => request<unknown>('/api/connections/' + enc(name), { method: 'DELETE' }),
    reorderAgents: (names: string[]) => request<unknown>('/api/connections/order', { body: { names } }),
    testAgent: async (fields: object): Promise<TestResult> => parseTest(await request('/api/connections/test', { body: fields })),
    /** A new MCP token for an inbox agent (the old one stops working at once). */
    newToken: async (name: string): Promise<{ inboxToken?: string }> => { const o = await request<any>('/api/connections/' + enc(name) + '/token', { body: {} }); return { inboxToken: o.inboxToken }; },

    // ---- machines: one connector per computer, paired with a short-lived code ----
    machines: async (): Promise<Machine[]> => ((await request<{ machines?: Machine[] }>('/api/machines')).machines ?? []),
    createPairing: (machineId?: string) => request<Pairing>('/api/machines/pairing', { body: machineId ? { machineId } : {} }),
    pairingStatus: async (code: string): Promise<PairingState> => { const o = await request<any>('/api/machines/pairing?code=' + enc(code)); return o.state === 'paired' ? { state: 'paired', machine: o.machine } : { state: o.state === 'expired' ? 'expired' : 'waiting' }; },
    renameMachine: (id: string, name: string) => request<unknown>('/api/machines/' + enc(id), { method: 'PATCH', body: { name } }),
    revokeMachine: (id: string) => request<unknown>('/api/machines/' + enc(id), { method: 'DELETE' }),
    rotateMachine: (id: string) => request<Pairing>('/api/machines/' + enc(id) + '/token', { body: {} }),

    // ---- sessions and skills ----
    sessions: async (agent: string, o: { limit?: number; offset?: number; q?: string } = {}): Promise<SessionPage> => {
      const q = new URLSearchParams({ limit: String(o.limit ?? 30), offset: String(o.offset ?? 0), ...(o.q ? { q: o.q } : {}) });
      const r = await request<any>(`/api/agents/${enc(agent)}/sessions?${q}`);
      const sessions: SessionInfo[] = (r.sessions ?? []).filter((s: any) => s?.id).map((s: any) => ({ id: String(s.id), title: typeof s.title === 'string' ? s.title : undefined, ...(Number(s.updated) ? { updated: Number(s.updated) } : {}), ...(typeof s.preview === 'string' && s.preview ? { preview: s.preview } : {}), ...(Number.isInteger(s.messages) ? { messages: s.messages } : {}), ...(s.pinned ? { pinned: true } : {}) }));
      return { sessions, total: Number.isInteger(r.total) ? r.total : sessions.length };
    },
    /** One page of a conversation, newest first by page (offset counts back from the end); messages inside a page are chronological. */
    messages: async (agent: string, id: string, o: { limit?: number; offset?: number } = {}): Promise<HistoryPage> => {
      const r = await request<any>(`/api/agents/${enc(agent)}/sessions/${enc(id)}/messages?limit=${o.limit ?? 80}&offset=${o.offset ?? 0}`);
      return { messages: (r.messages ?? []).map(fromHistory).filter((m: UiMessage | null): m is UiMessage => !!m), hasMore: r.has_more === true };
    },
    renameSession: (agent: string, id: string, title: string) => request<unknown>(`/api/agents/${enc(agent)}/sessions/${enc(id)}`, { method: 'PATCH', body: { title } }),
    deleteSession: (agent: string, id: string) => request<unknown>(`/api/agents/${enc(agent)}/sessions/${enc(id)}`, { method: 'DELETE' }),
    /** Slash-command catalog for this agent (the hub serves the bundled Hermes list for Hermes agents, nothing for others). */
    commands: async (agent: string): Promise<Catalog> => { try { const r = await request<any>(`/api/agents/${enc(agent)}/commands`); return { source: String(r.source ?? ''), commands: Array.isArray(r.commands) ? r.commands : [] }; } catch (e) { if (e instanceof AuthRequiredError) throw e; return BUNDLED_CATALOG; } },
    historyRetention: async (): Promise<number> => Number((await request<any>('/api/history/settings')).retentionDays),
    setHistoryRetention: (retentionDays: number) => request<unknown>('/api/history/settings', { method: 'PUT', body: { retentionDays } }),
    skills: async (agent: string): Promise<string[]> => { try { const o = await request<any>(`/api/agents/${enc(agent)}/skills`); const a = o.skills ?? o.data ?? []; return [...new Set<string>(a.map((x: any) => (typeof x === 'string' ? x : x?.name)).filter((x: unknown): x is string => typeof x === 'string' && !!x))].slice(0, 200); } catch (e) { if (e instanceof AuthRequiredError) throw e; return []; } },

    /**
     * Streams a reply. The hub keeps the agent run alive if this connection drops, so a broken stream is resumed from the
     * last event id (a few tries with backoff) instead of ending the chat. Resolves with the session id.
     */
    chat: async (agent: string, history: UiMessage[], opts: StreamOpts & { sessionId?: string }): Promise<string | undefined> => {
      let res: Response;
      try {
        res = await f(`${base}/api/agents/${enc(agent)}/chat`, { method: 'POST', credentials: 'same-origin', signal: opts.signal, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'hermes-agent', stream: true, ...(opts.sessionId ? { session_id: opts.sessionId } : {}), messages: chatMessages(history) }) });
      } catch (e) { if ((e as Error).name === 'AbortError') throw e; throw new NetworkError(); }
      return pump(agent, res, opts);
    },
    /** Reattaches to a run (after a reload or a dropped connection) and replays it from the start (after = 0) or a cursor. */
    follow: async (agent: string, run: string, after: number, opts: StreamOpts): Promise<string | undefined> => {
      const res = await openEvents(agent, run, after, opts.signal);
      return pump(agent, res, opts, run, after);
    },
    runs: async (agent: string, session?: string): Promise<RunInfo[]> => ((await request<any>(`/api/agents/${enc(agent)}/runs${session ? '?session_id=' + enc(session) : ''}`)).runs ?? []) as RunInfo[],
    /** The explicit Stop button: cancels the agent run itself (just closing the page never does). */
    stopRun: (agent: string, run: string) => request<any>(`/api/agents/${enc(agent)}/runs/${enc(run)}/stop`, { body: {} }),
    /** Send while the agent may be replying. The hub stores and acknowledges it first; mode says what to do if it is busy. */
    sendMessage: async (agent: string, o: { messages: UiMessage[]; sessionId?: string; mode: SendMode; clientId: string }): Promise<SendResult> => {
      const r = await request<any>(`/api/agents/${enc(agent)}/messages`, { body: { model: 'hermes-agent', messages: chatMessages(o.messages), mode: o.mode, client_id: o.clientId, ...(o.sessionId ? { session_id: o.sessionId } : {}) } });
      return { message: parseQueued(r.message), runId: typeof r.run_id === 'string' ? r.run_id : undefined, sessionId: typeof r.session_id === 'string' ? r.session_id : undefined };
    },
    queue: async (agent: string, session?: string): Promise<QueueState> => parseQueue(await request<any>(`/api/agents/${enc(agent)}/queue${session ? '?session_id=' + enc(session) : ''}`)),
    resumeQueue: async (agent: string, session?: string): Promise<QueueState> => parseQueue(await request<any>(`/api/agents/${enc(agent)}/queue/resume${session ? '?session_id=' + enc(session) : ''}`, { body: {} })),
    /** Answer an open question or approval, once, by its id. A 404 means it is already closed (answered elsewhere or cancelled). */
    answerRequest: (agent: string, session: string, id: string, result: Record<string, unknown>) => request<any>(`/api/agents/${enc(agent)}/native/sessions/${enc(session)}/requests/${enc(id)}`, { body: { result } }),
    /** Models the agent's profile offers (native sessions). */
    models: async (agent: string): Promise<{ providers: { slug: string; name: string; models: string[]; current?: boolean }[]; current?: string }> => { const r = await request<any>(`/api/agents/${enc(agent)}/native/models`); return { providers: (Array.isArray(r?.providers) ? r.providers : []).map((p: any) => ({ slug: String(p?.slug ?? ''), name: String(p?.name ?? p?.slug ?? ''), models: (Array.isArray(p?.models) ? p.models : []).map(String), ...(p?.current === true ? { current: true } : {}) })), ...(typeof r?.current === 'string' ? { current: r.current } : {}) }; },
    /** Session-scoped model change: this conversation only, never the profile default. */
    setModel: (agent: string, session: string, model: string) => request<any>(`/api/agents/${enc(agent)}/native/sessions/${enc(session)}/model`, { body: { model } }),
    /** The profile-wide "messages sent while it works" default of the agent. Changing it affects every chat of that profile. */
    profileBusy: async (agent: string): Promise<string> => String((await request<any>(`/api/agents/${enc(agent)}/native/busy`)).mode ?? ''),
    setProfileBusy: (agent: string, mode: SendMode) => request<any>(`/api/agents/${enc(agent)}/native/busy`, { body: { mode, confirm: true } }),
    cancelQueued: (agent: string, id: string, session?: string) => request<any>(`/api/agents/${enc(agent)}/queue/${enc(id)}${session ? '?session_id=' + enc(session) : ''}`, { method: 'DELETE' }),

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
export type Client = ReturnType<typeof createClient>;
