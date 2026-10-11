// Foxfleet Bot Screen viewer: noVNC (MPL-2.0) against the hub's ticketed WebSocket relay.
// The native side calls window.hub.connect(url) / setControl(bool) / press(name) / type(text) / toggleMod(name) / setZoom(mode) / setPan(bool) / showKeyboard().
// Events go back through window.FoxfleetBridge.onEvent(type, detail): ready, connected, disconnected, name, error, state (JSON of zoom/pan/mods).
import RFB from './novnc/core/rfb.js';
import { attachControls } from './controls.js';
import { pickBox, checkDisplayed, scaleXY, lumaStats, visibleVerdict, isBlankVerdict, intersect, intersectRect, countBytes } from './viewmetrics.js';

let rfb = null, ctl = null;
// ---- diagnostics: what a person needs to tell us why the view is black (shown as a strip with hub.setDebug(true); copied with hub.diagnostics()) ----
const T0 = Date.now(), logs = [];
const D = { state: 'idle', name: '', fb: '', css: '', dpr: window.devicePixelRatio || 1, view: '', frames: 0, lastFrameAgo: null, bytes: 0, error: '', blank: null, verdict: '', canvas: '', scaleXY: '', box: '', fixes: 0, msgs: 0, sample: '', visible: '', secure: window.isSecureContext, origin: location.origin, ua: navigator.userAgent, webgl: '', url: '' };
const note = (m) => { logs.push(`${((Date.now() - T0) / 1000).toFixed(1)}s ${m}`); if (logs.length > 40) logs.shift(); };
let lastFrame = 0, blankRuns = 0, sampler = 0, noFrameTimer = 0, strip = null, stripTimer = 0;
for (const lvl of ['log', 'info', 'warn', 'error']) { const o = console[lvl]?.bind(console); console[lvl] = (...a) => { note(`console.${lvl}: ${a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 160)}`); o?.(...a); }; }
function snapshot() {
  const c = rfb?._canvas, r = c?.getBoundingClientRect?.();
  D.fb = rfb ? `${rfb._fbWidth}x${rfb._fbHeight}` : ''; D.css = r ? `${Math.round(r.width)}x${Math.round(r.height)}` : ''; D.view = `${innerWidth}x${innerHeight}`;
  D.canvas = c ? `${c.width}x${c.height}` : ''; D.scaleXY = r && rfb ? scaleXY({ w: r.width, h: r.height }, { w: rfb._fbWidth, h: rfb._fbHeight }) : '';
  D.lastFrameAgo = lastFrame ? Math.round((Date.now() - lastFrame) / 100) / 10 : null; return D;
}
function report() { const d = snapshot(); return JSON.stringify({ ...d, log: logs.slice(-25) }); }
function setState(s, extra) { D.state = s; note('state ' + s + (extra ? ' ' + extra : '')); }
const shownSize = () => { const r = rfb?._canvas?.getBoundingClientRect?.(); return r ? { w: r.width, h: r.height } : null; };
// What a person SEES: sample the canvas backing store but judge it together with its DISPLAYED size (a painted 1440x900 canvas shown at 2x1 CSS px is a black screen).
// The part of the canvas that is really on screen: its rect intersected with #screen (which clips it) and the window.
function visibleSize() {
  const c = rfb?._canvas?.getBoundingClientRect?.(), s = document.getElementById('screen')?.getBoundingClientRect?.(); if (!c || !s) return null;
  return intersect(intersectRect(c, s), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
}
function sampleVerdict() {
  const c = rfb?._canvas; if (!c || !c.width || !c.height) return null;
  const shown = shownSize(); let stats = null;
  try {
    const t = document.createElement('canvas'); t.width = 24; t.height = 24; const g = t.getContext('2d', { willReadFrequently: true }); g.drawImage(c, 0, 0, 24, 24);
    stats = lumaStats(g.getImageData(0, 0, 24, 24).data); D.sample = `24x24 of ${c.width}x${c.height} luma ${Math.round(stats.min)}-${Math.round(stats.max)} mean ${Math.round(stats.mean)}`;
  } catch (e) { note('sample failed: ' + e.message); }
  const vis = visibleSize(); D.visible = vis ? `${Math.round(vis.w)}x${Math.round(vis.h)}` : '';
  return visibleVerdict(shown, stats, vis);
}
// Self-heal: noVNC scales once from the container size it measured; on Android that can be a ~2px box (WebView before layout) and the observer then misses the real size.
// Window-fallback: the container is a sliver, so a canvas scaled to the window would be clipped by it. Size #screen to the window (inline !important beats the stylesheet).
function forceHostSize(host) { host.dataset.ffWindowFit = '1'; host.style.setProperty('width', innerWidth + 'px', 'important'); host.style.setProperty('height', innerHeight + 'px', 'important'); host.style.setProperty('min-width', '0', 'important'); host.style.setProperty('min-height', '0', 'important'); }
// Event-driven callers go through the debounce; the sampler tick and tests call ensureFit directly.
let fitTimer = 0; const requestFit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(ensureFit, 80); };
function ensureFit() {
  if (!rfb || !rfb._fbWidth || !rfb.scaleViewport) return;
  // A forced window-size container (set below) must follow the window, or it would clip after a rotation.
  const host = document.getElementById('screen'); if (host?.dataset?.ffWindowFit) forceHostSize(host);
  const shown = shownSize(), fb = { w: rfb._fbWidth, h: rfb._fbHeight };
  const cr = host?.getBoundingClientRect?.(), box = pickBox(cr ? { w: cr.width, h: cr.height } : null, { w: innerWidth, h: innerHeight });
  D.box = box ? `${Math.round(box.w)}x${Math.round(box.h)} (${box.from})` : 'none';
  const chk = checkDisplayed(shown, fb, box); if (!box || !(chk.collapsed || chk.wrong)) return;
  D.fixes++; note(`refit: shown ${shown ? Math.round(shown.w) + 'x' + Math.round(shown.h) : '?'} expected ${chk.expected.w}x${chk.expected.h} box ${D.box}`);
  try { if (box.from === 'container') rfb._updateScale(); else { forceHostSize(host); rfb._display.autoscale(box.w, box.h); } } catch (e) { note('refit failed: ' + e.message); }
}
function startSampling() {
  clearInterval(sampler); blankRuns = 0;
  sampler = setInterval(() => {
    ensureFit(); const v = sampleVerdict(); if (v === null) return; D.verdict = v; const b = isBlankVerdict(v);
    blankRuns = b ? blankRuns + 1 : 0; const now = blankRuns >= 3 ? true : b ? D.blank : false;
    if (now !== D.blank) { D.blank = now; note('blank=' + now); post('blank', String(now)); }
  }, 1200);
}
function ensureStrip() {
  if (strip) return strip; strip = document.createElement('div');
  strip.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9;font:11px/1.35 monospace;color:#bfffcf;background:rgba(0,0,0,.78);padding:3px 6px;white-space:pre-wrap;pointer-events:none';
  document.body.appendChild(strip); return strip;
}
function drawStrip() { const d = snapshot(); ensureStrip().textContent = `${d.state} · fb ${d.fb || '-'} · view ${d.view}@${d.dpr} · canvas ${d.css || '-'} · frames ${d.frames}${d.lastFrameAgo !== null ? ` (${d.lastFrameAgo}s ago)` : ''} · blank ${d.blank === null ? '?' : d.blank} (${d.verdict || '?'}) · rx ${d.bytes}B${d.error ? '\nerror: ' + d.error : ''}`; }
// noVNC keeps no byte counter: wrap the raw WebSocket's onmessage (attached synchronously inside new RFB()).
function watchBytes() {
  const ws = rfb?._sock?._websocket; if (!ws || ws.__ffb) return; ws.__ffb = true;
  const ctr = { get bytes() { return D.bytes; }, set bytes(v) { D.bytes = v; }, get msgs() { return D.msgs; }, set msgs(v) { D.msgs = v; } };
  ws.onmessage = countBytes(ctr, ws.onmessage);
}
function watchFrames() {
  const d = rfb?._display; if (!d || d.__ff) return; d.__ff = true; const flip = d.flip.bind(d);
  d.flip = (...a) => { D.frames++; lastFrame = Date.now(); if (D.frames <= 3 || D.frames % 60 === 0) requestFit(); return flip(...a); };
  watchBytes();
}

const post = (type, detail) => window.FoxfleetBridge?.onEvent(type, detail ?? '');
// Never fail silently: a script error on this page must reach the app, which shows it instead of a blank view.
window.addEventListener('error', (e) => { D.error = 'js: ' + String(e.message || 'script error').slice(0, 100); note(D.error); post('error', D.error); });
window.addEventListener('unhandledrejection', (e) => { D.error = 'js: ' + String(e.reason?.message || e.reason || 'rejected').slice(0, 100); note(D.error); post('error', D.error); });

function connect(url) {
  clearInterval(sampler); clearTimeout(noFrameTimer); clearTimeout(fitTimer);
  D.url = url.replace(/ticket=[^&]+/, 'ticket=…'); D.frames = 0; D.bytes = 0; D.msgs = 0; D.fixes = 0; D.verdict = ''; D.blank = null; D.error = ''; lastFrame = 0; setState('connecting');
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
new ResizeObserver(() => { if (!rfb) return; try { rfb.scaleViewport = rfb.scaleViewport; requestFit(); const r = rfb._canvas?.getBoundingClientRect(); if (r && (r.width < 2 || r.height < 2) && rfb._fbWidth) note('canvas has no size: ' + r.width + 'x' + r.height); } catch {} }).observe(document.getElementById('screen'));
try { const gl = document.createElement('canvas').getContext('webgl'); D.webgl = gl ? 'yes' : 'no'; } catch { D.webgl = 'error'; }
window.hub = {
  connect,
  diagnostics: report,
  setDebug(on) { clearInterval(stripTimer); if (on) { drawStrip(); stripTimer = setInterval(drawStrip, 500); } else if (strip) { strip.remove(); strip = null; } },
  disconnect() { clearInterval(sampler); clearTimeout(noFrameTimer); clearTimeout(fitTimer); rfb?.disconnect(); rfb = null; ctl?.detach(); ctl = null; },
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
for (const t of ['resize', 'orientationchange']) addEventListener(t, requestFit);
note('page ready ' + location.origin); post('ready');
