// Touch + keyboard controls for the Bot Screen viewer, shared by the web app and the Android page (android/app/src/main/assets/controls.js is an
// identical copy; a test keeps them equal). It sits on top of an unmodified noVNC RFB instance:
//   tap = left click · long-press = right click (hold) · drag = move/drag · two-finger drag = scroll   (noVNC's own gestures)
//   pinch = local zoom between Fit and 100%  (intercepted here, before noVNC would turn it into Ctrl+wheel on the remote)
//   sticky Ctrl / Alt / Shift, Esc / Tab / Enter / arrows, the soft keyboard
export const KEYSYMS = { Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, Backspace: 0xff08, Up: 0xff52, Down: 0xff54, Left: 0xff51, Right: 0xff53, Home: 0xff50, End: 0xff57, PageUp: 0xff55, PageDown: 0xff56, Delete: 0xffff };
const MODS = { ctrl: [0xffe3, 'ControlLeft'], alt: [0xffe9, 'AltLeft'], shift: [0xffe1, 'ShiftLeft'] };
export const PINCH_IN = 1.2, PINCH_OUT = 1 / 1.2;

export function attachControls(host, getRfb, { onChange = () => {} } = {}) {
  const mods = { ctrl: false, alt: false, shift: false };
  let zoom = 'fit', pan = false, startMag = 0, lastMag = 0;
  const rfb = () => getRfb();
  const emit = () => onChange({ zoom, pan, mods: { ...mods } });

  function setZoom(mode) {
    const r = rfb(); zoom = mode === '100' ? '100' : 'fit';
    if (r) {
      r.scaleViewport = zoom === 'fit'; r.clipViewport = zoom !== 'fit';
      r.dragViewport = zoom !== 'fit' && pan; // 1:1 can pan with one finger (pan mode) or keep dragging the mouse
    }
    emit();
  }
  function setPan(on) { pan = Boolean(on); const r = rfb(); if (r && zoom !== 'fit') r.dragViewport = pan; emit(); }
  function toggleMod(name) { if (!(name in mods)) return; mods[name] = !mods[name]; emit(); }
  /** Send a key with the sticky modifiers held, then release them (one-shot, like a phone keyboard shift). */
  function press(key) {
    const r = rfb(); if (!r || r.viewOnly) return false;
    const sym = typeof key === 'number' ? key : KEYSYMS[key]; if (sym === undefined) return false;
    const held = Object.keys(mods).filter((m) => mods[m]);
    for (const m of held) r.sendKey(MODS[m][0], MODS[m][1], true);
    r.sendKey(sym, typeof key === 'string' ? key : undefined);
    for (const m of held.reverse()) r.sendKey(MODS[m][0], MODS[m][1], false);
    if (held.length) { for (const m of held) mods[m] = false; emit(); }
    return true;
  }
  /** Text from the soft keyboard: each character becomes a key press (code points above Latin-1 use the Unicode keysym range). */
  function type(text) {
    for (const ch of text) { if (ch === '\n') press('Enter'); else { const c = ch.codePointAt(0); press(c < 256 ? c : 0x01000000 | c); } }
  }
  function releaseAll() { const r = rfb(); for (const m of Object.keys(mods)) if (mods[m] && r) r.sendKey(MODS[m][0], MODS[m][1], false); for (const m of Object.keys(mods)) mods[m] = false; emit(); }

  // Capture phase on an ancestor runs before noVNC's own listeners on the canvas, so a pinch never reaches it.
  const mag = (d) => Math.hypot(d.magnitudeX || 0, d.magnitudeY || 0);
  const gesture = (ev) => {
    if (ev.detail?.type !== 'pinch') return;
    ev.stopImmediatePropagation();
    if (ev.type === 'gesturestart') { startMag = lastMag = mag(ev.detail); }
    else if (ev.type === 'gesturemove') { lastMag = mag(ev.detail); }
    else if (ev.type === 'gestureend') {
      lastMag = mag(ev.detail) || lastMag;
      if (startMag > 0) { const ratio = lastMag / startMag; if (ratio > PINCH_IN && zoom === 'fit') setZoom('100'); else if (ratio < PINCH_OUT && zoom !== 'fit') setZoom('fit'); }
      startMag = lastMag = 0;
    }
  };
  for (const t of ['gesturestart', 'gesturemove', 'gestureend']) host.addEventListener(t, gesture, true);
  const detach = () => { for (const t of ['gesturestart', 'gesturemove', 'gestureend']) host.removeEventListener(t, gesture, true); };
  return { setZoom, setPan, toggleMod, press, type, releaseAll, detach, get state() { return { zoom, pan, mods: { ...mods } }; } };
}
