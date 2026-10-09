// Foxfleet Bot Screen viewer: noVNC (MPL-2.0) against the hub's ticketed WebSocket relay.
// The native side calls window.hub.connect(url) / setControl(bool) / key(name) / showKeyboard().
import RFB from './novnc/core/rfb.js';
import KeyTable from './novnc/core/input/keysym.js';

let rfb = null;
const post = (type, detail) => window.FoxfleetBridge?.onEvent(type, detail ?? '');

function connect(url) {
  if (rfb) { try { rfb.disconnect(); } catch {} }
  rfb = new RFB(document.getElementById('screen'), url, { shared: true });
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = false;
  rfb.background = '#0b0b0c';
  rfb.addEventListener('connect', () => post('connected'));
  rfb.addEventListener('disconnect', (e) => post('disconnected', e.detail.clean ? 'clean' : 'error'));
  rfb.addEventListener('securityfailure', (e) => post('error', e.detail.reason || 'security failure'));
  rfb.addEventListener('desktopname', (e) => post('name', e.detail.name));
}

const keys = { Escape: KeyTable.XK_Escape, Tab: KeyTable.XK_Tab, Enter: KeyTable.XK_Return, Backspace: KeyTable.XK_BackSpace,
  Up: KeyTable.XK_Up, Down: KeyTable.XK_Down, Left: KeyTable.XK_Left, Right: KeyTable.XK_Right };

// Soft keyboard: type into a hidden textarea and forward characters as keysyms.
const kbd = document.getElementById('kbd');
kbd.addEventListener('input', () => {
  if (!rfb || rfb.viewOnly) { kbd.value = ''; return; }
  for (const ch of kbd.value) {
    if (ch === '\n') rfb.sendKey(KeyTable.XK_Return, 'Enter');
    else rfb.sendKey(ch.codePointAt(0) < 256 ? ch.codePointAt(0) : 0x01000000 | ch.codePointAt(0));
  }
  kbd.value = '';
});
kbd.addEventListener('keydown', (e) => {
  if (!rfb || rfb.viewOnly) return;
  if (e.key === 'Backspace') { rfb.sendKey(KeyTable.XK_BackSpace, 'Backspace'); e.preventDefault(); }
});

window.hub = {
  connect,
  disconnect() { rfb?.disconnect(); rfb = null; },
  setControl(on) { if (rfb) { rfb.viewOnly = !on; if (on) rfb.focus(); else kbd.blur(); } },
  key(name) { if (rfb && !rfb.viewOnly && keys[name]) rfb.sendKey(keys[name], name); },
  ctrlAltDel() { if (rfb && !rfb.viewOnly) rfb.sendCtrlAltDel(); },
  showKeyboard() { kbd.focus(); },
};
post('ready');
