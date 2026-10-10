// Foxfleet Bot Screen viewer: noVNC (MPL-2.0) against the hub's ticketed WebSocket relay.
// The native side calls window.hub.connect(url) / setControl(bool) / press(name) / type(text) / toggleMod(name) / setZoom(mode) / setPan(bool) / showKeyboard().
// Events go back through window.FoxfleetBridge.onEvent(type, detail): ready, connected, disconnected, name, error, state (JSON of zoom/pan/mods).
import RFB from './novnc/core/rfb.js';
import { attachControls } from './controls.js';

let rfb = null, ctl = null;
// ---- diagnostics: what a person needs to tell us why the view is black (shown as a strip with hub.setDebug(true); copied with hub.diagnostics()) ----
const T0 = Date.now(), logs = [];
const D = { state: 'idle', name: '', fb: '', css: '', dpr: window.devicePixelRatio || 1, view: '', frames: 0, lastFrameAgo: null, bytes: 0, error: '', blank: null, secure: window.isSecureContext, origin: location.origin, ua: navigator.userAgent, webgl: '', url: '' };
const note = (m) => { logs.push(`${((Date.now() - T0) / 1000).toFixed(1)}s ${m}`); if (logs.length > 40) logs.shift(); };
let lastFrame = 0, blankRuns = 0, sampler = 0, noFrameTimer = 0, strip = null, stripTimer = 0;
for (const lvl of ['log', 'info', 'warn', 'error']) { const o = console[lvl]?.bind(console); console[lvl] = (...a) => { note(`console.${lvl}: ${a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 160)}`); o?.(...a); }; }
function snapshot() {
  const c = rfb?._canvas, r = c?.getBoundingClientRect?.();
  D.fb = rfb ? `${rfb._fbWidth}x${rfb._fbHeight}` : ''; D.css = r ? `${Math.round(r.width)}x${Math.round(r.height)}` : ''; D.view = `${innerWidth}x${innerHeight}`;
  D.lastFrameAgo = lastFrame ? Math.round((Date.now() - lastFrame) / 100) / 10 : null; return D;
}
function report() { const d = snapshot(); return JSON.stringify({ ...d, log: logs.slice(-25) }); }
function setState(s, extra) { D.state = s; note('state ' + s + (extra ? ' ' + extra : '')); }
// Is the remote picture empty? Sample the canvas on a tiny grid: a desktop that never painted (no window manager / wallpaper) is one flat colour.
function sampleBlank() {
  const c = rfb?._canvas; if (!c || !c.width || !c.height) return null;
  try {
    const t = document.createElement('canvas'); t.width = 24; t.height = 24; const g = t.getContext('2d', { willReadFrequently: true }); g.drawImage(c, 0, 0, 24, 24);
    const px = g.getImageData(0, 0, 24, 24).data; let min = 255, max = 0;
    for (let i = 0; i < px.length; i += 4) { const l = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10; if (l < min) min = l; if (l > max) max = l; }
    return max - min < 6 && max < 40;
  } catch (e) { note('sample failed: ' + e.message); return null; }
}
function startSampling() {
  clearInterval(sampler); blankRuns = 0;
  sampler = setInterval(() => {
    const b = sampleBlank(); if (b === null) return;
    blankRuns = b ? blankRuns + 1 : 0; const now = blankRuns >= 3 ? true : b ? D.blank : false;
    if (now !== D.blank) { D.blank = now; note('blank=' + now); post('blank', String(now)); }
  }, 1200);
}
function ensureStrip() {
  if (strip) return strip; strip = document.createElement('div');
  strip.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9;font:11px/1.35 monospace;color:#bfffcf;background:rgba(0,0,0,.78);padding:3px 6px;white-space:pre-wrap;pointer-events:none';
  document.body.appendChild(strip); return strip;
}
function drawStrip() { const d = snapshot(); ensureStrip().textContent = `${d.state} · fb ${d.fb || '-'} · view ${d.view}@${d.dpr} · canvas ${d.css || '-'} · frames ${d.frames}${d.lastFrameAgo !== null ? ` (${d.lastFrameAgo}s ago)` : ''} · blank ${d.blank === null ? '?' : d.blank}${d.error ? '\nerror: ' + d.error : ''}`; }
function watchFrames() {
  const d = rfb?._display; if (!d || d.__ff) return; d.__ff = true; const flip = d.flip.bind(d);
  d.flip = (...a) => { D.frames++; lastFrame = Date.now(); return flip(...a); };
  const sock = rfb._sock; if (sock?._eventHandlers) { /* byte counting: noVNC's Websock exposes rQlen only; frames are the signal */ }
}

const post = (type, detail) => window.FoxfleetBridge?.onEvent(type, detail ?? '');
// Never fail silently: a script error on this page must reach the app, which shows it instead of a blank view.
window.addEventListener('error', (e) => { D.error = 'js: ' + String(e.message || 'script error').slice(0, 100); note(D.error); post('error', D.error); });
window.addEventListener('unhandledrejection', (e) => { D.error = 'js: ' + String(e.reason?.message || e.reason || 'rejected').slice(0, 100); note(D.error); post('error', D.error); });

function connect(url) {
  D.url = url.replace(/ticket=[^&]+/, 'ticket=…'); D.frames = 0; D.blank = null; D.error = ''; lastFrame = 0; setState('connecting');
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
  watchFrames();
  rfb.addEventListener('connect', () => {
    setState('connected'); post('connected'); startSampling();
    clearTimeout(noFrameTimer); noFrameTimer = setTimeout(() => { if (!D.frames) { D.error = 'connected but no picture arrived'; note(D.error); post('noframes'); } }, 6000);
  });
  rfb.addEventListener('disconnect', (e) => { setState('disconnected', e.detail.clean ? 'clean' : 'error'); clearInterval(sampler); clearTimeout(noFrameTimer); post('disconnected', e.detail.clean ? 'clean' : 'error'); });
  rfb.addEventListener('securityfailure', (e) => { D.error = 'security: ' + (e.detail.reason || 'failed'); note(D.error); post('error', e.detail.reason || 'security failure'); });
  rfb.addEventListener('credentialsrequired', () => { D.error = 'the machine asked for a VNC password'; note(D.error); post('error', D.error); });
  rfb.addEventListener('desktopname', (e) => { D.name = e.detail.name; post('name', e.detail.name); });
}

// Soft keyboard: type into a hidden textarea and forward characters as keysyms.
const kbd = document.getElementById('kbd');
kbd.addEventListener('input', () => { if (!rfb || rfb.viewOnly) { kbd.value = ''; return; } ctl?.type(kbd.value); kbd.value = ''; });
kbd.addEventListener('keydown', (e) => { if (!rfb || rfb.viewOnly) return; if (e.key === 'Backspace') { ctl?.press('Backspace'); e.preventDefault(); } });

// The page itself can be sized 0 for a moment on Android (WebView measured before layout): nudge noVNC to scale again whenever the container changes.
new ResizeObserver(() => { if (!rfb) return; try { rfb.scaleViewport = rfb.scaleViewport; const r = rfb._canvas?.getBoundingClientRect(); if (r && (r.width < 2 || r.height < 2) && rfb._fbWidth) note('canvas has no size: ' + r.width + 'x' + r.height); } catch {} }).observe(document.getElementById('screen'));
try { const gl = document.createElement('canvas').getContext('webgl'); D.webgl = gl ? 'yes' : 'no'; } catch { D.webgl = 'error'; }
window.hub = {
  connect,
  diagnostics: report,
  setDebug(on) { clearInterval(stripTimer); if (on) { drawStrip(); stripTimer = setInterval(drawStrip, 500); } else if (strip) { strip.remove(); strip = null; } },
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
note('page ready ' + location.origin); post('ready');
