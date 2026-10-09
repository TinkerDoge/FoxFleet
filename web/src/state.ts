import { createClient, type Client } from './api/client';
import { hubName } from './lib/hubAddress';

const KEY = 'foxfleet.hub', THEME = 'foxfleet.theme', ACCENT = 'foxfleet.accent';
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
  if (accent) r.dataset.accent = accent;
}
export function setTheme(mode: 'light' | 'dark' | 'system') { try { mode === 'system' ? store()?.removeItem(THEME) : store()?.setItem(THEME, mode); } catch { /* ignore */ } applyPrefs(); }
