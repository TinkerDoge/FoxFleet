// Per-chat background: which look a conversation has (default / solid colour / pattern / picture) and how a picture is dimmed and blurred.
// Everything stays on this device: settings in localStorage, the (downscaled) picture in IndexedDB. Nothing is sent to the hub.
// The presets (colours, pattern tiles, limits) come from design/tokens.json, the same source the Android app is generated from.
import tokens from '../../../design/tokens.json';
import { fitDimensions } from './images';

export type BgMode = 'default' | 'solid' | 'pattern' | 'image';
export interface ChatBg { mode: BgMode; solid: string; pattern: string; blur: number; dim: number; image: boolean }
export interface Solid { id: string; name: string; light: string; dark: string }
export interface Pattern { id: string; name: string; width: number; height: number; stroke: number; opacity: { light: number; dark: number }; shapes: { d: string; fill?: boolean }[] }

const cfg = tokens.chatBackgrounds as { solids: Solid[]; patterns: Pattern[]; image: { blurMax: number; dimMax: number; dimDefault: number; maxEdge: number; quality: number } };
export const SOLIDS = cfg.solids, PATTERNS = cfg.patterns, LIMITS = cfg.image;

export const DEFAULT_BG: ChatBg = { mode: 'default', solid: '', pattern: PATTERNS[0].id, blur: 0, dim: LIMITS.dimDefault, image: false };
export const isDefault = (b: ChatBg) => b.mode === 'default';
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/** Untrusted stored JSON becomes a valid setting: unknown ids fall back, numbers are clamped, an image mode without a stored picture is dropped. */
export function normalizeBg(raw: unknown): ChatBg {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const solid = SOLIDS.some((s) => s.id === o.solid) ? (o.solid as string) : '';
  const pattern = PATTERNS.some((p) => p.id === o.pattern) ? (o.pattern as string) : DEFAULT_BG.pattern;
  const image = o.image === true;
  let mode: BgMode = (['default', 'solid', 'pattern', 'image'] as const).includes(o.mode as BgMode) ? (o.mode as BgMode) : 'default';
  if (mode === 'solid' && !solid) mode = 'default';
  if (mode === 'image' && !image) mode = 'default';
  return { mode, solid, pattern, image, blur: Math.round(clamp(Number(o.blur ?? 0), 0, LIMITS.blurMax)), dim: Math.round(clamp(Number(o.dim ?? LIMITS.dimDefault), 0, LIMITS.dimMax) * 100) / 100 };
}

/** The key of one conversation. A chat that has no id yet (before the first message) is the agent's "new chat" slot. */
export const chatBgKey = (agent: string, session?: string) => `${agent}\u0000${session ?? ''}`;
const LS = 'foxfleet.chatbg.';
const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export const loadBg = (key: string): ChatBg => safe(() => normalizeBg(JSON.parse(localStorage.getItem(LS + key) || 'null')), DEFAULT_BG);
export const saveBg = (key: string, bg: ChatBg) => safe(() => { if (isDefault(bg) && !bg.image) localStorage.removeItem(LS + key); else localStorage.setItem(LS + key, JSON.stringify(bg)); }, undefined);

// ---- the picture: IndexedDB, behind a tiny interface so the logic is testable without a browser database ----
export interface ImageStore { get(key: string): Promise<Blob | undefined>; put(key: string, blob: Blob): Promise<void>; delete(key: string): Promise<void>; clear(): Promise<void> }

export function idbStore(name = 'foxfleet-chatbg'): ImageStore {
  let db: Promise<IDBDatabase> | undefined;
  const open = () => (db ??= new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('images');
    r.onsuccess = () => res(r.result); r.onerror = () => { db = undefined; rej(r.error); };
  }));
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => { const d = await open(); return new Promise<T>((res, rej) => { const q = f(d.transaction('images', mode).objectStore('images')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  return {
    get: async (k) => (await run('readonly', (s) => s.get(k))) as Blob | undefined,
    put: async (k, b) => { await run('readwrite', (s) => s.put(b, k)); },
    delete: async (k) => { await run('readwrite', (s) => s.delete(k)); },
    clear: async () => { await run('readwrite', (s) => s.clear()); },
  };
}
let store: ImageStore | undefined;
export const images = (): ImageStore => (store ??= idbStore());
export const setImageStore = (s: ImageStore | undefined) => { store = s; };

/** Reset to default: the setting and the stored picture both go. */
export async function resetBg(key: string, s: ImageStore = images()): Promise<ChatBg> { safe(() => localStorage.removeItem(LS + key), undefined); await s.delete(key).catch(() => {}); return DEFAULT_BG; }
/** A chat that just received its id keeps the look it had as a new chat (only if the saved chat has none of its own). */
export async function moveBg(from: string, to: string, s: ImageStore = images()): Promise<void> {
  if (from === to) return; const bg = loadBg(from); if (isDefault(bg) && !bg.image) return;
  if (!isDefault(loadBg(to)) || loadBg(to).image) return;
  const blob = bg.image ? await s.get(from).catch(() => undefined) : undefined;
  if (blob) await s.put(to, blob).catch(() => {});
  saveBg(to, blob || !bg.image ? bg : { ...bg, image: false, mode: bg.mode === 'image' ? 'default' : bg.mode });
  await resetBg(from, s);
}
/** Wipes every chat background and picture (used when a different account or hub takes over this device, never on a plain sign-out). */
export async function forgetAllBgs(s: ImageStore = images()): Promise<void> {
  safe(() => { for (const k of Object.keys(localStorage)) if (k.startsWith(LS)) localStorage.removeItem(k); }, undefined);
  await s.clear().catch(() => {});
}

/** Largest size for the stored picture: long edge at most `maxEdge` (1600 by default), never upscaled. */
export const backgroundSize = (w: number, h: number) => fitDimensions(w, h, LIMITS.maxEdge);
export interface Encode { (width: number, height: number, quality: number): Promise<Blob> }
/** Re-encode a picked picture small: fit 1600 px, JPEG. Injectable `encode` for tests; the browser path decodes with EXIF orientation. */
export async function prepareBackground(w: number, h: number, encode: Encode): Promise<Blob> {
  const d = backgroundSize(w, h); return encode(d.width, d.height, LIMITS.quality);
}
export async function downscaleBackground(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return await prepareBackground(bmp.width, bmp.height, (width, height, quality) => new Promise<Blob>((res, rej) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      const g = c.getContext('2d'); if (!g) return rej(new Error('Canvas is not available'));
      g.drawImage(bmp, 0, 0, width, height); c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the picture'))), 'image/jpeg', quality);
    }));
  } finally { bmp.close?.(); }
}

// ---- pattern tiles: a mask, so the ink follows the theme (`--text`) and the opacity comes from the token ----
export function patternSvg(p: Pattern): string {
  const body = p.shapes.map((s) => (s.fill ? `<path d="${s.d}" fill="#000"/>` : `<path d="${s.d}" fill="none" stroke="#000" stroke-width="${p.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}">${body}</svg>`;
}
export const patternUrl = (p: Pattern) => `url("data:image/svg+xml,${encodeURIComponent(patternSvg(p))}")`;
export const solidVar = (id: string) => `var(--chat-solid-${id})`;

// ---- who owns the data on this device ----
// Sign-out keeps backgrounds. They are cleared only when a DIFFERENT account or hub signs in; the owner key sits next to the data.
const OWNER = 'foxfleet.chatbgowner';
/** One spelling per hub: scheme and host lower-case, default port and trailing slashes dropped, no query or fragment. '' means this origin. */
export function normalizeHubKey(hub: string, origin = typeof location !== 'undefined' ? location.origin : ''): string {
  let text = (hub || origin).trim(); if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
  try { const u = new URL(text); return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return text.toLowerCase().replace(/\/+$/, ''); }
}
/** Stable account id (not the display name, which can be reused) plus the normalised hub. */
export const ownerKey = (accountId: string | undefined, hub: string) => `${(accountId ?? '').trim() || 'anonymous'}@${normalizeHubKey(hub)}`;
export type Claim = 'adopted' | 'kept' | 'cleared';
/**
 * Called once a session is signed in. Nothing stored: adopt (this also adopts older data that has no owner key). Same owner: keep.
 * Different owner: the settings go at once and the pictures right after, before anything is drawn for the new owner.
 */
export function claimBgOwner(owner: string, s: ImageStore = images()): Claim {
  const had = safe(() => localStorage.getItem(OWNER), null);
  if (had === owner) return 'kept';
  if (had === null) { safe(() => localStorage.setItem(OWNER, owner), undefined); return 'adopted'; }
  safe(() => { for (const k of Object.keys(localStorage)) if (k.startsWith(LS)) localStorage.removeItem(k); localStorage.setItem(OWNER, owner); }, undefined);
  void s.clear().catch(() => {});
  return 'cleared';
}
