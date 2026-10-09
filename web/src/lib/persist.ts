// What the web app remembers across reloads and closed tabs: the last agent and, per agent, the open session and the
// in-flight run (so reopening the page restores the same chat and reattaches to the reply that kept running on the hub).
// Only ids and the pending user text are stored here, never keys or tokens.
export interface SavedChat { session?: string; run?: string; user?: string; started?: number }
const KEY = (agent: string) => 'foxfleet.chat.' + agent, LAST = 'foxfleet.lastAgent';
const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export const loadSaved = (agent: string): SavedChat => safe(() => { const v = JSON.parse(localStorage.getItem(KEY(agent)) || '{}'); return v && typeof v === 'object' ? { session: typeof v.session === 'string' ? v.session : undefined, run: typeof v.run === 'string' ? v.run : undefined, user: typeof v.user === 'string' ? v.user : undefined, started: Number(v.started) || undefined } : {}; }, {});
export const saveChat = (agent: string, patch: Partial<SavedChat>) => safe(() => { const next = { ...loadSaved(agent), ...patch }; for (const k of Object.keys(next) as (keyof SavedChat)[]) if (next[k] === undefined) delete next[k]; localStorage.setItem(KEY(agent), JSON.stringify(next)); }, undefined);
export const clearSaved = (agent: string) => safe(() => localStorage.removeItem(KEY(agent)), undefined);
export const lastAgent = () => safe(() => localStorage.getItem(LAST) || undefined, undefined);
export const rememberAgent = (agent: string) => safe(() => localStorage.setItem(LAST, agent), undefined);
export const forgetAll = () => safe(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('foxfleet.chat.') || k === LAST) localStorage.removeItem(k); }, undefined);
