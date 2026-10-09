// Port of the Android HubAddress rules: https required except explicit LAN/dev opt-in; only a bare origin is stored.
export interface ConnectLink { hub: string; invite?: string }

export const PLACEHOLDER = 'https://hub.example.com';

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); }
  return !h.includes('.') && /^[a-z0-9-]+$/.test(h) && h !== '';
}

/** Returns the normalized origin, or an error message. */
export function normalizeHub(input: string, allowHttp = false): { url?: string; error?: string } {
  let raw = input.trim();
  if (!raw) return { error: 'Enter the hub address.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = (isLocalHost(raw.split(/[/:]/)[0]) && allowHttp ? 'http://' : 'https://') + raw;
  let u: URL;
  try { u = new URL(raw); } catch { return { error: `That doesn't look like an address. Try ${PLACEHOLDER}` }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Use an http or https address.' };
  if (u.username || u.password) return { error: 'Leave out the username and password.' };
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return { error: `Use just the address, like ${PLACEHOLDER}` };
  if (u.protocol === 'http:' && !(allowHttp && isLocalHost(u.hostname))) return { error: 'Public hubs must use https. For a hub on your own network, allow http below.' };
  return { url: u.origin };
}

/** foxfleet://connect?hub=...&invite=... (also accepts the same query on a normal URL: ?hub=). */
export function parseLink(link: string): ConnectLink | null {
  const m = /^foxfleet:\/\/connect\?(.*)$/i.exec(link.trim());
  if (!m && /^[a-z][a-z0-9+.-]*:/i.test(link.trim()) && !/^https?:/i.test(link.trim())) return null;
  const query = m ? m[1] : link.includes('?') ? link.slice(link.indexOf('?') + 1) : '';
  const p = new URLSearchParams(query);
  const hub = p.get('hub')?.trim();
  if (!hub || (!m && !/^https?:\/\//i.test(hub))) return null;
  const invite = p.get('invite') ?? undefined;
  return { hub, ...(invite && /^[A-Za-z0-9_-]{8,64}$/.test(invite) ? { invite } : {}) };
}

export function hubName(url: string): string { try { return new URL(url).host; } catch { return url; } }
