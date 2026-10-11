import { beforeEach, describe, expect, it } from 'vitest';
import tokens from '../../design/tokens.json';
import { forgetAll } from '../src/lib/persist';
import { claimBgOwner, normalizeHubKey, ownerKey, DEFAULT_BG, LIMITS, PATTERNS, SOLIDS, backgroundSize, chatBgKey, forgetAllBgs, isDefault, loadBg, moveBg, normalizeBg, patternSvg, patternUrl, prepareBackground, resetBg, saveBg, type ImageStore } from '../src/lib/chatBg';

function memory(): ImageStore & { map: Map<string, Blob> } {
  const map = new Map<string, Blob>();
  return { map, get: async (k) => map.get(k), put: async (k, b) => { map.set(k, b); }, delete: async (k) => { map.delete(k); }, clear: async () => { map.clear(); } };
}
const blob = (n = 'x') => new Blob([n], { type: 'image/jpeg' });
beforeEach(() => localStorage.clear());

describe('chat background settings', () => {
  it('has 8-10+ patterns and a solid set from the shared tokens, with unique ids and a tint per mode', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(8); expect(PATTERNS.length).toBeLessThanOrEqual(12);
    expect(new Set(PATTERNS.map((p) => p.id)).size).toBe(PATTERNS.length); expect(new Set(SOLIDS.map((s) => s.id)).size).toBe(SOLIDS.length);
    for (const p of PATTERNS) { expect(p.opacity.light).toBeGreaterThan(0); expect(p.opacity.dark).toBeLessThanOrEqual(0.25); expect(p.opacity.light).toBeLessThanOrEqual(0.25); expect(patternSvg(p)).toContain(`viewBox="0 0 ${p.width} ${p.height}"`); }
    for (const id of ['paws', 'foxes', 'dots', 'grid', 'waves', 'topography', 'stars', 'doodles']) expect(PATTERNS.map((p) => p.id)).toContain(id);
  });
  it('defaults to the app background and keys a chat by agent and session', () => {
    expect(loadBg('a\u0000s1')).toEqual(DEFAULT_BG); expect(isDefault(DEFAULT_BG)).toBe(true);
    expect(chatBgKey('atlas', 's1')).not.toBe(chatBgKey('atlas', 's2')); expect(chatBgKey('atlas')).toBe('atlas\u0000');
  });
  it('stores per chat, round-trips, and removes the entry when it is the default again', () => {
    const a = chatBgKey('atlas', '1'), b = chatBgKey('atlas', '2');
    saveBg(a, normalizeBg({ mode: 'pattern', pattern: 'paws', solid: 'sage' })); saveBg(b, normalizeBg({ mode: 'solid', solid: 'sky' }));
    expect(loadBg(a)).toMatchObject({ mode: 'pattern', pattern: 'paws', solid: 'sage' }); expect(loadBg(b)).toMatchObject({ mode: 'solid', solid: 'sky' });
    saveBg(a, DEFAULT_BG); expect(localStorage.getItem('foxfleet.chatbg.' + a)).toBeNull(); expect(loadBg(b).mode).toBe('solid');
  });
  it('repairs untrusted data: unknown ids, bad numbers, image mode without a stored picture', () => {
    expect(normalizeBg('nonsense')).toEqual(DEFAULT_BG); expect(normalizeBg(null)).toEqual(DEFAULT_BG);
    expect(normalizeBg({ mode: 'solid', solid: 'nope' }).mode).toBe('default');
    expect(normalizeBg({ mode: 'pattern', pattern: 'nope' }).pattern).toBe(DEFAULT_BG.pattern);
    expect(normalizeBg({ mode: 'image', image: false }).mode).toBe('default');
    const n = normalizeBg({ mode: 'image', image: true, blur: 999, dim: 5 }); expect(n.blur).toBe(LIMITS.blurMax); expect(n.dim).toBe(LIMITS.dimMax);
    const m = normalizeBg({ mode: 'image', image: true, blur: -4, dim: -1 }); expect(m.blur).toBe(0); expect(m.dim).toBe(0);
    expect(normalizeBg({ mode: 'image', image: true, blur: 'x', dim: NaN })).toMatchObject({ blur: 0, dim: 0 });
  });
  it('survives corrupt localStorage JSON', () => { localStorage.setItem('foxfleet.chatbg.k', '{oops'); expect(loadBg('k')).toEqual(DEFAULT_BG); });
  it('reset removes the setting and the stored picture', async () => {
    const s = memory(), k = chatBgKey('atlas', '1'); await s.put(k, blob()); saveBg(k, normalizeBg({ mode: 'image', image: true, blur: 6, dim: 0.4 }));
    expect(await resetBg(k, s)).toEqual(DEFAULT_BG); expect(loadBg(k)).toEqual(DEFAULT_BG); expect(s.map.has(k)).toBe(false);
  });
  it('a new chat keeps its look when it gets an id, and never overwrites a saved chat', async () => {
    const s = memory(), from = chatBgKey('atlas'), to = chatBgKey('atlas', 'sess'), other = chatBgKey('atlas', 'old');
    await s.put(from, blob('pic')); saveBg(from, normalizeBg({ mode: 'image', image: true, blur: 3, dim: 0.5 }));
    await moveBg(from, to, s);
    expect(loadBg(to)).toMatchObject({ mode: 'image', blur: 3, dim: 0.5, image: true }); expect(s.map.has(to)).toBe(true); expect(s.map.has(from)).toBe(false); expect(loadBg(from)).toEqual(DEFAULT_BG);
    saveBg(from, normalizeBg({ mode: 'solid', solid: 'sand' })); saveBg(other, normalizeBg({ mode: 'solid', solid: 'sky' }));
    await moveBg(from, other, s); expect(loadBg(other).solid).toBe('sky');
  });
  it('forgetAllBgs wipes every chat background and picture but leaves other keys', async () => {
    const s = memory(); localStorage.setItem('other', '1'); saveBg('a', normalizeBg({ mode: 'solid', solid: 'sky' })); await s.put('a', blob());
    await forgetAllBgs(s); expect(loadBg('a')).toEqual(DEFAULT_BG); expect(s.map.size).toBe(0); expect(localStorage.getItem('other')).toBe('1');
  });
});

describe('picture preparation', () => {
  it('fits a large photo into 1600 px on the long edge, keeps the aspect, never upscales', async () => {
    expect(backgroundSize(4000, 3000)).toEqual({ width: 1600, height: 1200 }); expect(backgroundSize(3000, 4000)).toEqual({ width: 1200, height: 1600 }); expect(backgroundSize(800, 600)).toEqual({ width: 800, height: 600 });
    let seen: number[] = []; const out = await prepareBackground(6000, 4000, async (w, h, q) => { seen = [w, h, q]; return blob(); });
    expect(out).toBeInstanceOf(Blob); expect(seen[0]).toBe(1600); expect(seen[1]).toBe(1067); expect(seen[2]).toBeCloseTo(tokens.chatBackgrounds.image.quality);
  });
});

describe('pattern tiles', () => {
  it('make a mask URL that is valid, small and ink-neutral (colour comes from the theme)', () => {
    for (const p of PATTERNS) { const u = patternUrl(p); expect(u.startsWith('url("data:image/svg+xml,')).toBe(true); expect(decodeURIComponent(u).replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|href/); expect(u.length).toBeLessThan(3500); }
  });
});

describe('contrast over the presets', () => {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255), lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (h: string) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: text on every solid colour is readable and cards still stand apart from the solid`, () => {
      const c: any = tokens.colors[mode];
      for (const s of SOLIDS) {
        expect(ratio(c.text, (s as any)[mode]), s.id).toBeGreaterThanOrEqual(7); expect(ratio(c.textMuted, (s as any)[mode]), s.id).toBeGreaterThanOrEqual(4.5);
        expect(ratio(c.surface, (s as any)[mode]), s.id + ' vs surface').toBeGreaterThanOrEqual(mode === 'dark' ? 1.04 : 1.03);
      }
    });
  }
  it('dark bg is only a little lighter than before and the cards keep a gap to it', () => {
    const d: any = tokens.colors.dark; expect(ratio(d.surface, d.bg)).toBeGreaterThanOrEqual(1.1); expect(ratio(d.surfaceAlt, d.surface)).toBeGreaterThanOrEqual(1.08);
    expect(ratio(d.bg, '#110F0E')).toBeLessThan(1.15);
  });
});

describe('owner key: backgrounds survive sign-out, a different account or hub clears them', () => {
  const alice = ownerKey('u-alice', 'https://hub.example.com'), seed = async (s: ReturnType<typeof memory>) => { saveBg('a', normalizeBg({ mode: 'image', image: true, blur: 3, dim: 0.3 })); await s.put('a', blob()); };
  it('legacy data without an owner key is adopted for the current owner and kept', async () => {
    const s = memory(); await seed(s);
    expect(claimBgOwner(alice, s)).toBe('adopted'); expect(loadBg('a').mode).toBe('image'); expect(s.map.has('a')).toBe(true); expect(localStorage.getItem('foxfleet.chatbgowner')).toBe(alice);
  });
  it('same owner: sign-out then sign-in keeps settings and pictures (sign-out itself wipes nothing)', async () => {
    const s = memory(); claimBgOwner(alice, s); await seed(s);
    forgetAll(); // what Sign out runs
    expect(loadBg('a').mode).toBe('image'); expect(s.map.has('a')).toBe(true);
    expect(claimBgOwner(ownerKey('u-alice', 'https://hub.example.com'), s)).toBe('kept'); expect(loadBg('a').mode).toBe('image'); expect(s.map.has('a')).toBe(true);
  });
  it('a different account on the same hub clears everything before it is shown', async () => {
    const s = memory(); claimBgOwner(alice, s); await seed(s);
    expect(claimBgOwner(ownerKey('u-bob', 'https://hub.example.com'), s)).toBe('cleared');
    expect(loadBg('a')).toEqual(DEFAULT_BG); await Promise.resolve(); expect(s.map.size).toBe(0); expect(localStorage.getItem('foxfleet.chatbgowner')).toBe(ownerKey('u-bob', 'https://hub.example.com'));
    expect(claimBgOwner(alice, s)).toBe('cleared'); // and back again: nothing of Bob's either
  });
  it('a different hub clears, even for the same account id', async () => {
    const s = memory(); claimBgOwner(alice, s); await seed(s);
    expect(claimBgOwner(ownerKey('u-alice', 'https://other.example.com'), s)).toBe('cleared'); expect(loadBg('a')).toEqual(DEFAULT_BG);
  });
  it('a failed or cancelled sign-in never claims, so nothing is wiped or shown', async () => {
    const s = memory(); claimBgOwner(alice, s); await seed(s);
    forgetAll(); // signed out, then the next sign-in fails: claimBgOwner is only called by a signed-in Shell
    expect(loadBg('a').mode).toBe('image'); expect(localStorage.getItem('foxfleet.chatbgowner')).toBe(alice);
  });
  it('hub spelling does not matter: case, trailing slash, default port, query, same-origin', () => {
    const a = normalizeHubKey('https://Hub.Example.com/');
    for (const v of ['https://hub.example.com', 'HTTPS://HUB.EXAMPLE.COM///', 'https://hub.example.com:443', ' hub.example.com ', 'https://hub.example.com/?x=1#y']) expect(normalizeHubKey(v), v).toBe(a);
    expect(normalizeHubKey('https://hub.example.com/team')).not.toBe(a); expect(normalizeHubKey('http://hub.example.com')).not.toBe(a);
    expect(normalizeHubKey('', 'https://Here.Example.com')).toBe('https://here.example.com');
    expect(ownerKey('u1', 'https://A.example.com/')).toBe(ownerKey(' u1 ', 'https://a.example.com')); expect(ownerKey(undefined, 'https://a.example.com')).toBe('anonymous@https://a.example.com');
    expect(ownerKey('u1', 'https://a.example.com')).not.toBe(ownerKey('U1', 'https://a.example.com'));
  });
  it('the same account after a spelling change of the hub still keeps its data', async () => {
    const s = memory(); claimBgOwner(ownerKey('u1', 'https://Hub.example.com/'), s); await seed(s);
    expect(claimBgOwner(ownerKey('u1', 'https://hub.example.com'), s)).toBe('kept'); expect(loadBg('a').mode).toBe('image');
  });
});
