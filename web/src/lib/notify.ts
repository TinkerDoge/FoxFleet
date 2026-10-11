// Notification prefs of the hub (GET/PUT /api/notify/prefs, PUT /api/notify/mute): a master switch and agent / chat mutes.
export interface MuteRule { agent: string; chat: string | null; until: number | null }
export interface NotifyPrefs { enabled: boolean; storageOk: boolean; mutes: MuteRule[] }

export const MUTE_CHOICES: { key: 'notify.for1h' | 'notify.for8h' | 'notify.for24h' | 'notify.forever'; ms: number | null }[] = [
  { key: 'notify.for1h', ms: 3_600_000 }, { key: 'notify.for8h', ms: 8 * 3_600_000 }, { key: 'notify.for24h', ms: 24 * 3_600_000 }, { key: 'notify.forever', ms: null },
];

export function parseNotifyPrefs(o: any): NotifyPrefs {
  const rule = (r: any, withChat: boolean): MuteRule | null => {
    if (!r || typeof r.agent !== 'string' || !r.agent) return null;
    if (withChat && (typeof r.chat !== 'string' || !r.chat)) return null;
    return { agent: r.agent, chat: withChat ? r.chat : null, until: typeof r.until === 'number' ? r.until : null };
  };
  const list = (v: unknown, withChat: boolean) => (Array.isArray(v) ? v : []).map((r) => rule(r, withChat)).filter((r): r is MuteRule => !!r);
  return { enabled: o?.enabled !== false, storageOk: o?.storage?.ok !== false, mutes: [...list(o?.agents, false), ...list(o?.chats, true)] };
}

/** Mutes that still apply (a timed mute that ran out is gone from the hub's view anyway; this guards a stale list). */
export const activeMutes = (p: NotifyPrefs, now: number) => p.mutes.filter((m) => m.until === null || m.until > now);
