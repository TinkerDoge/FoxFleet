import { useEffect, useState } from 'preact/hooks';

/** A Telegram-style choice card shown in the message stream. It belongs to the chat that opened it and expires. */
export interface Picker { id: string; agent: string; session?: string; kind: 'model' | 'choice'; command?: string; options?: string[]; openedAt: number }
export const PICKER_TTL_MS = 5 * 60_000;
const open = new Map<string, Picker>(); const subs = new Set<() => void>();
let seq = 1;
const emit = () => subs.forEach((f) => f());
/** Opens (replacing any other card of this agent). */
export function openPicker(p: Omit<Picker, 'id' | 'openedAt'>, now = Date.now()): Picker { const full = { ...p, id: `pk${seq++}`, openedAt: now }; open.set(p.agent, full); emit(); return full; }
export function closePicker(agent: string, id?: string) { const p = open.get(agent); if (p && (!id || p.id === id)) { open.delete(agent); emit(); } }
/** The card to show, only if it was opened in this very chat and has not expired. */
export function activePicker(agent: string, session: string | undefined, now = Date.now()): Picker | undefined {
  const p = open.get(agent); if (!p) return undefined;
  if (p.session !== session || now - p.openedAt > PICKER_TTL_MS) return undefined;
  return p;
}
export function usePicker(agent: string, session: string | undefined): Picker | undefined {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); const timer = setInterval(f, 30_000); return () => { subs.delete(f); clearInterval(timer); }; }, []);
  return activePicker(agent, session);
}
export const resetPickers = () => { open.clear(); emit(); };
/** Filter and page a list for the picker. */
export function pageOf<T>(items: T[], page: number, size = 8): { rows: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(items.length / size)), p = Math.min(Math.max(0, page), pages - 1);
  return { rows: items.slice(p * size, p * size + size), pages, page: p };
}
