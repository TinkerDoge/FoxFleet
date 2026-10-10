import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { attachControls, KEYSYMS } from '../src/screen/controls.js';
import { screenProblem } from '../src/screen/problems';

const fakeRfb = () => { const calls: any[] = []; return { calls, viewOnly: false, scaleViewport: true, clipViewport: false, dragViewport: false, sendKey: (...a: any[]) => calls.push(['key', ...a]) } as any; };
const gesture = (host: HTMLElement, type: string, detail: any) => { const canvas = host.querySelector('canvas')!; let reached = false; canvas.addEventListener(type, () => { reached = true; }); canvas.dispatchEvent(new CustomEvent(type, { detail })); return reached; };
const mount = () => { const host = document.createElement('div'); host.innerHTML = '<canvas></canvas>'; document.body.append(host); const rfb = fakeRfb(); const seen: any[] = []; const c = attachControls(host, () => rfb, { onChange: (s: any) => seen.push(s) }); return { host, rfb, c, seen }; };

describe('screen controls', () => {
  it('keeps the Android copy identical to the web copy', () => {
    expect(readFileSync('../android/app/src/main/assets/controls.js', 'utf8')).toBe(readFileSync('src/screen/controls.js', 'utf8'));
  });
  it('sticky modifiers wrap one key press and then release', () => {
    const { rfb, c, seen } = mount();
    c.toggleMod('ctrl'); c.toggleMod('alt'); expect(c.state.mods).toEqual({ ctrl: true, alt: true, shift: false });
    expect(c.press('Tab')).toBe(true);
    expect(rfb.calls).toEqual([['key', 0xffe3, 'ControlLeft', true], ['key', 0xffe9, 'AltLeft', true], ['key', KEYSYMS.Tab, 'Tab'], ['key', 0xffe9, 'AltLeft', false], ['key', 0xffe3, 'ControlLeft', false]]);
    expect(c.state.mods).toEqual({ ctrl: false, alt: false, shift: false }); expect(seen.at(-1).mods.ctrl).toBe(false);
  });
  it('does nothing while view-only, and typed text becomes key presses (newline = Enter, non-Latin-1 = Unicode keysym)', () => {
    const { rfb, c } = mount(); rfb.viewOnly = true; expect(c.press('Escape')).toBe(false); expect(rfb.calls).toEqual([]);
    rfb.viewOnly = false; c.type('a\n€');
    expect(rfb.calls).toEqual([['key', 0x61, undefined], ['key', KEYSYMS.Enter, 'Enter'], ['key', 0x01000000 | 0x20ac, undefined]]);
  });
  it('a pinch out zooms to 100% (clip + pan), a pinch in goes back to Fit, and noVNC never sees the pinch', () => {
    const { host, rfb, c } = mount(); c.setPan(true);
    gesture(host, 'gesturestart', { type: 'pinch', magnitudeX: 100, magnitudeY: 0 });
    expect(gesture(host, 'gesturemove', { type: 'pinch', magnitudeX: 200, magnitudeY: 0 })).toBe(false);
    gesture(host, 'gestureend', { type: 'pinch', magnitudeX: 220, magnitudeY: 0 });
    expect(c.state.zoom).toBe('100'); expect(rfb).toMatchObject({ scaleViewport: false, clipViewport: true, dragViewport: true });
    gesture(host, 'gesturestart', { type: 'pinch', magnitudeX: 200, magnitudeY: 0 }); gesture(host, 'gestureend', { type: 'pinch', magnitudeX: 100, magnitudeY: 0 });
    expect(c.state.zoom).toBe('fit'); expect(rfb).toMatchObject({ scaleViewport: true, clipViewport: false, dragViewport: false });
  });
  it('lets noVNC have taps, long-presses, drags and two-finger scrolls', () => {
    const { host } = mount();
    for (const type of ['onetap', 'longpress', 'drag', 'twodrag']) expect(gesture(host, 'gesturestart', { type, clientX: 1, clientY: 1 })).toBe(true);
  });
});

describe('screen problems (shared vectors)', () => {
  const vectors = JSON.parse(readFileSync('../contract/screen-problems.vectors.json', 'utf8'));
  for (const v of vectors.cases) it(JSON.stringify(v.in), () => { expect(screenProblem(v.in)).toEqual({ kind: v.kind, update: v.update ?? false }); });
});
