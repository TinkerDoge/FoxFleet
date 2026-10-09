import { createClient, type Client } from './api/client';
import { hubName } from './lib/hubAddress';

const KEY = 'foxfleet.hub', THEME = 'foxfleet.theme', ACCENT = 'foxfleet.accent', TEXT = 'foxfleet.text', MOTION = 'foxfleet.motion';
const store = (): Storage | null => { try { return localStorage; } catch { return null; } };

/** '' means same origin as the page (the normal case: the hub serves this app). */
export const loadHub = (): string => store()?.getItem(KEY) ?? '';
export const saveHub = (url: string) => { try { url ? store()?.setItem(KEY, url) : store()?.removeItem(KEY); } catch { /* private mode */ } };
export const makeClient = (hub = loadHub()): Client => createClient({ base: hub });
export const displayHub = (hub: string) => (hub ? hubName(hub) : location.host);

export function applyPrefs() {
  const s = store(), r = document.documentElement;
  const theme = s?.getItem(THEME), accent = s?.getItem(ACCENT);
  if (theme === 'light' || theme === 'dark') r.dataset.theme = theme; else delete r.dataset.theme;
  if (accent) r.dataset.accent = accent; else delete r.dataset.accent;
  const text = s?.getItem(TEXT), motion = s?.getItem(MOTION);
  if (text === 'small' || text === 'large') r.dataset.text = text; else delete r.dataset.text;
  if (motion === 'reduce') r.dataset.motion = 'reduce'; else delete r.dataset.motion;
}
export type TextSize = 'small' | 'normal' | 'large';
export interface Prefs { theme: 'light' | 'dark' | 'system'; accent: string; text: TextSize; motion: 'system' | 'reduce' }
export function getPrefs(): Prefs {
  const s = store(), g = (k: string) => s?.getItem(k);
  return { theme: g(THEME) === 'light' || g(THEME) === 'dark' ? (g(THEME) as 'light' | 'dark') : 'system', accent: g(ACCENT) || 'ember', text: g(TEXT) === 'small' || g(TEXT) === 'large' ? (g(TEXT) as TextSize) : 'normal', motion: g(MOTION) === 'reduce' ? 'reduce' : 'system' };
}
const put = (k: string, v: string | null) => { try { v === null ? store()?.removeItem(k) : store()?.setItem(k, v); } catch { /* private mode */ } applyPrefs(); };
export const setAccent = (id: string) => put(ACCENT, id === 'ember' ? null : id);
export const setTextSize = (t: TextSize) => put(TEXT, t === 'normal' ? null : t);
export const setMotion = (m: 'system' | 'reduce') => put(MOTION, m === 'system' ? null : m);
export function setTheme(mode: 'light' | 'dark' | 'system') { try { mode === 'system' ? store()?.removeItem(THEME) : store()?.setItem(THEME, mode); } catch { /* ignore */ } applyPrefs(); }
