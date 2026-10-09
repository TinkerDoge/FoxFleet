import { describe, expect, it } from 'vitest';
import tokens from '../../design/tokens.json';

// WCAG 2.x relative luminance / contrast, applied to the shared design tokens (the same ones Android is generated from).
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => { const [r, g, b] = rgb(hex).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const on = (bg: string, fg: string, alpha: number) => { const A = rgb(bg), B = rgb(fg); return '#' + A.map((c, i) => Math.round((c * (1 - alpha) + B[i] * alpha) * 255).toString(16).padStart(2, '0')).join(''); };

describe('colour contrast (WCAG AA = 4.5:1 for text, 3:1 for UI components)', () => {
  for (const mode of ['light', 'dark'] as const) {
    const c: any = tokens.colors[mode];
    it(`${mode}: body and muted text on bg, surface, surfaceAlt`, () => {
      for (const bg of [c.bg, c.surface, c.surfaceAlt]) { expect(contrast(c.text, bg)).toBeGreaterThanOrEqual(7); expect(contrast(c.textMuted, bg)).toBeGreaterThanOrEqual(4.5); }
    });
    it(`${mode}: danger text on bg and surface`, () => { for (const bg of [c.bg, c.surface]) expect(contrast(c.danger, bg)).toBeGreaterThanOrEqual(4.5); });
    it(`${mode}: online and idle status colours are visible (3:1) on surface`, () => { expect(contrast(c.online, c.surface)).toBeGreaterThanOrEqual(3); expect(contrast(c.idle, c.surface)).toBeGreaterThanOrEqual(3); });
    for (const a of tokens.accents) {
      const accent = (a as any)[mode];
      it(`${mode}/${a.id}: accent used as link text is 4.5:1 on bg and surface; text on a user bubble stays readable`, () => {
        for (const bg of [c.bg, c.surface]) expect(contrast(accent, bg)).toBeGreaterThanOrEqual(4.5);
        const bubble = on(c.bg, accent, (tokens as any).userBubbleAlpha[mode]); expect(contrast(c.text, bubble)).toBeGreaterThanOrEqual(7);
      });
    }
  }
});
