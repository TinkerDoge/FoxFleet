// Foxfleet Bot Screen viewer: noVNC (MPL-2.0) against the hub's ticketed WebSocket relay.
// The native side calls window.hub.connect(url) / setControl(bool) / press(name) / type(text) / toggleMod(name) / setZoom(mode) / setPan(bool) / showKeyboard().
// Events go back through window.FoxfleetBridge.onEvent(type, detail): ready, connected, disconnected, name, error, state (JSON of zoom/pan/mods).
import RFB from './novnc/core/rfb.js';
import { attachControls } from './controls.js';

let rfb = null, ctl = null;
const post = (type, detail) => window.FoxfleetBridge?.onEvent(type, detail ?? '');
// Never fail silently: a script error on this page must reach the app, which shows it instead of a blank view.
window.addEventListener('error', (e) => post('error', 'js: ' + String(e.message || 'script error').slice(0, 100)));
window.addEventListener('unhandledrejection', (e) => post('error', 'js: ' + String(e.reason?.message || e.reason || 'rejected').slice(0, 100)));

function connect(url) {
  if (rfb) { try { rfb.disconnect(); } catch {} }
  ctl?.detach();
  rfb = new RFB(document.getElementById('screen'), url, { shared: true });
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = false;
  rfb.background = '#0b0b0c';
  ctl = attachControls(document.getElementById('screen'), () => rfb, { onChange: (s) => post('state', JSON.stringify(s)) });
  ctl.setZoom('fit');
  rfb.addEventListener('connect', () => post('connected'));
  rfb.addEventListener('disconnect', (e) => post('disconnected', e.detail.clean ? 'clean' : 'error'));
  rfb.addEventListener('securityfailure', (e) => post('error', e.detail.reason || 'security failure'));
  rfb.addEventListener('desktopname', (e) => post('name', e.detail.name));
}

// Soft keyboard: type into a hidden textarea and forward characters as keysyms.
const kbd = document.getElementById('kbd');
kbd.addEventListener('input', () => { if (!rfb || rfb.viewOnly) { kbd.value = ''; return; } ctl?.type(kbd.value); kbd.value = ''; });
kbd.addEventListener('keydown', (e) => { if (!rfb || rfb.viewOnly) return; if (e.key === 'Backspace') { ctl?.press('Backspace'); e.preventDefault(); } });

window.hub = {
  connect,
  disconnect() { rfb?.disconnect(); rfb = null; ctl?.detach(); ctl = null; },
  setControl(on) { if (rfb) { rfb.viewOnly = !on; if (on) rfb.focus(); else { kbd.blur(); ctl?.releaseAll(); } } },
  key(name) { ctl?.press(name); },          // kept for older callers
  press(name) { return ctl?.press(name) ?? false; },
  type(text) { ctl?.type(text); },
  toggleMod(name) { ctl?.toggleMod(name); },
  setZoom(mode) { ctl?.setZoom(mode); },
  setPan(on) { ctl?.setPan(on); },
  ctrlAltDel() { if (rfb && !rfb.viewOnly) rfb.sendCtrlAltDel(); },
  showKeyboard() { kbd.focus(); },
};
post('ready');
