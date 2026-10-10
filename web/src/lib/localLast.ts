// The last message of each chat, kept on THIS device whenever you send or a reply finishes. The agent list falls back to it when the hub does not
// (yet) know: an older hub without agent activity, a chat started elsewhere that was not seeded, or a hub that just restarted.
import type { AgentSummary } from '../api/types';

const KEY = 'foxfleet.last.';
let scope = 'local';
export const setLastScope = (id: string | undefined) => { scope = id || 'local'; };
type Last = { at: number; role: 'user' | 'assistant'; text: string };
const read = (): Record<string, Last> => { try { const v = JSON.parse(localStorage.getItem(KEY + scope) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

/** One line, no Markdown noise or MEDIA: tags, at most 140 characters (the hub applies the same rules to its own previews). */
export function previewOf(text: string): string {
  const s = String(text ?? '').replace(/^\s*MEDIA:.*$/gim, '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 139) + '…' : s;
}
export function rememberLast(agent: string, role: 'user' | 'assistant', text: string, at = Date.now()) {
  const p = previewOf(text); if (!p || !agent) return;
  try { const v = read(); v[agent] = { at, role, text: p }; const keys = Object.keys(v); if (keys.length > 200) delete v[keys[0]]; localStorage.setItem(KEY + scope, JSON.stringify(v)); } catch { /* private mode: the hub's data still shows */ }
}
/** The hub's answer wins when it is at least as new; otherwise this device knows better. Never invents anything. */
export function withLocalLast<T extends Pick<AgentSummary, 'name' | 'last_activity_at' | 'last_message_preview' | 'last_role'>>(a: T): T {
  const l = read()[a.name]; if (!l) return a;
  if ((a.last_activity_at ?? 0) >= l.at && a.last_message_preview) return a;
  if ((a.last_activity_at ?? 0) > l.at) return a;
  return { ...a, last_activity_at: l.at, last_message_preview: l.text, last_role: l.role };
}
export const forgetLast = () => { try { for (const k of Object.keys(localStorage)) if (k.startsWith(KEY)) localStorage.removeItem(k); } catch { /* ignore */ } };
