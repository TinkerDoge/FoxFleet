// What the agent list shows for each agent: order, preview line, time label, unread. The same rules run on Android (AgentList.kt)
// and in the hub (server/activity.js sortAgents); contract/agent-list.vectors.json pins the shared behaviour.
import type { AgentSummary } from '../api/types';

/** Pinned first (in the order they were pinned), then newest activity, then quiet agents in registry order. */
export function sortAgents<T extends Pick<AgentSummary, 'order' | 'pin_order' | 'last_activity_at'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const pa = a.pin_order ?? -1, pb = b.pin_order ?? -1;
    if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
    if (pa >= 0 && pb >= 0) return pa - pb;
    const ta = a.last_activity_at ?? 0, tb = b.last_activity_at ?? 0;
    if (ta !== tb) return tb - ta;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}

const dayNumber = (ms: number, timeZone?: string) => { const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 86_400_000; };
/** Right-hand time of a row: the clock today, the weekday within the last week, a short date after that (with the year when it is not this year). */
export function listTime(ms: number | null | undefined, now = Date.now(), locale?: string, timeZone?: string): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const days = dayNumber(now, timeZone) - dayNumber(ms, timeZone), d = new Date(ms), sameYear = new Date(ms).toLocaleDateString('en-CA', { timeZone, year: 'numeric' }) === new Date(now).toLocaleDateString('en-CA', { timeZone, year: 'numeric' });
  if (days <= 0) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone });
  if (days === 1) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-1, 'day').replace(/^./, (c) => c.toLocaleUpperCase(locale));
  if (days < 7) return d.toLocaleDateString(locale, { weekday: 'short', timeZone });
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone });
}

export type PreviewLine = { kind: 'typing' | 'approval' | 'text' | 'empty'; text: string; you: boolean };
/** Second line of a row. Running work and open requests win over the last message; "You: " marks your own. `running` is what this device knows locally. */
export function previewLine(a: Pick<AgentSummary, 'working' | 'needs_input' | 'last_message_preview' | 'last_session_title' | 'last_role' | 'description'>, running = false): PreviewLine {
  if (a.needs_input) return { kind: 'approval', text: '', you: false };
  if (a.working || running) return { kind: 'typing', text: '', you: false };
  const body = a.last_message_preview?.trim();
  if (body) return { kind: 'text', text: body, you: a.last_role === 'user' };
  const title = a.last_session_title?.trim();
  if (title) return { kind: 'text', text: title, you: false };
  return { kind: 'empty', text: a.description?.split('\n')[0]?.trim() ?? '', you: false };
}

/** Unread = the agent spoke after you last looked at this chat (kept per signed-in user on this device). */
const SEEN = 'foxfleet.seen.';
let scope = 'local';
export const setSeenScope = (id: string | undefined) => { scope = id || 'local'; };
const read = (): Record<string, number> => { try { const v = JSON.parse(localStorage.getItem(SEEN + scope) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
export const markSeen = (agent: string, at: number | null | undefined) => { if (!at) return; try { const v = read(); if ((v[agent] ?? 0) >= at) return; v[agent] = at; localStorage.setItem(SEEN + scope, JSON.stringify(v)); } catch { /* private mode */ } };
/** First time this device sees an agent: start it out as read. */
export const seedSeen = (agent: string, at: number | null | undefined) => { if (at && read()[agent] === undefined) markSeen(agent, at); };
export function isUnread(a: Pick<AgentSummary, 'name' | 'last_activity_at' | 'last_role'>, open: boolean): boolean {
  if (open || a.last_role !== 'assistant' || !a.last_activity_at) return false;
  const seen = read()[a.name];
  return seen === undefined ? false : a.last_activity_at > seen; // never seen on this device: nothing to flag, so a new device does not light up every agent
}
export const forgetSeen = () => { try { for (const k of Object.keys(localStorage)) if (k.startsWith(SEEN)) localStorage.removeItem(k); } catch { /* ignore */ } };

const HUES = [14, 28, 150, 200, 262, 330, 48, 180];
/** Stable colour + initials for agents without a picture. */
export function avatarSeed(name: string, label?: string): { initials: string; hue: number } {
  const text = (label || name).trim(), parts = text.split(/[\s_-]+/).filter(Boolean);
  const initials = ((parts.length > 1 ? parts[0][0] + parts[1][0] : text.slice(0, 2)) || '?').toUpperCase();
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { initials, hue: HUES[h % HUES.length] };
}
