import { ApiError, AuthRequiredError, NetworkError, RateLimitedError } from './errors';
import type { AgentSummary, AuthInfo, Registration } from './types';

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
  };
}
export type Client = ReturnType<typeof createClient>;
