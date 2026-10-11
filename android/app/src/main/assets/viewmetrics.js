// Pure sizing / sampling logic for the Android bot-screen page, kept free of DOM so it is unit-tested (server/test/screen-metrics.test.js).
// Background: Doge's phone reported css '2x1' (the displayed canvas was ~2x1 CSS px: noVNC scaled to a ~2px-wide container measured before layout),
// while the pixel sampler read the canvas BACKING STORE (1440x900, painted) and said blank:false -> a black screen that diagnostics called fine.
export const MIN_VISIBLE = 16; // CSS px: a displayed canvas smaller than this on either side is not a usable picture

/** Scale that fits a fb into a box (contain). 0 when either is empty. */
export const MAX_SCALE = 4;
export function fitScale(fbW, fbH, boxW, boxH) {
  if (!(fbW > 0 && fbH > 0 && boxW > 0 && boxH > 0)) return 0;
  const s = Math.min(boxW / fbW, boxH / fbH);
  return Number.isFinite(s) ? Math.min(Math.max(s, 0), MAX_SCALE) : 0;
}

/** Intersection of two {left,top,right,bottom} rects, as a rect (empty rects collapse to zero width/height). */
export function intersectRect(a, b) {
  if (!a || !b) return { left: 0, top: 0, right: 0, bottom: 0 };
  const l = Math.max(a.left, b.left), t = Math.max(a.top, b.top);
  return { left: l, top: t, right: Math.max(l, Math.min(a.right, b.right)), bottom: Math.max(t, Math.min(a.bottom, b.bottom)) };
}
/** {w,h} of the overlap of two rects. */
export const intersect = (a, b) => { const r = intersectRect(a, b); return { w: r.right - r.left, h: r.bottom - r.top }; };

/** The box to fit into: the container if it has a real size, else the window (WebView measured before layout), else null. */
export function pickBox(container, win, min = MIN_VISIBLE) {
  const ok = (b) => b && b.w >= min && b.h >= min;
  if (ok(container)) return { w: container.w, h: container.h, from: 'container' };
  if (ok(win)) return { w: win.w, h: win.h, from: 'window' };
  return null;
}

/** Is the displayed canvas collapsed / far from what a fit should give? Returns {collapsed, wrong, expected}. */
export function checkDisplayed(shown, fb, box, tol = 0.08) {
  const collapsed = !(shown && shown.w >= MIN_VISIBLE && shown.h >= MIN_VISIBLE);
  const s = box ? fitScale(fb.w, fb.h, box.w, box.h) : 0;
  const expected = { w: Math.round(fb.w * s), h: Math.round(fb.h * s) };
  const wrong = !collapsed && s > 0 && (Math.abs(shown.w - expected.w) > expected.w * tol + 2 || Math.abs(shown.h - expected.h) > expected.h * tol + 2);
  return { collapsed, wrong: collapsed ? s > 0 : wrong, expected };
}

/** Non-uniform scale (CSS size / framebuffer) per axis, as strings for the report. */
export function scaleXY(shown, fb) {
  if (!shown || !(fb.w > 0 && fb.h > 0)) return '';
  return `${(shown.w / fb.w).toFixed(4)}x${(shown.h / fb.h).toFixed(4)}`;
}

/** Luma stats of RGBA bytes: {min,max,mean,flat}. */
export function lumaStats(px) {
  let min = 255, max = 0, sum = 0, n = 0;
  for (let i = 0; i + 3 < px.length; i += 4) { const l = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10; if (l < min) min = l; if (l > max) max = l; sum += l; n++; }
  if (!n) return { min: 0, max: 0, mean: 0, flat: true, n: 0 };
  return { min, max, mean: sum / n, flat: max - min < 6, n };
}

/** Honest verdict for what the person SEES. `shown` is the canvas's own CSS size, `visible` the part of it inside its clipping container and the window (defaults to `shown`).
 *  'collapsed' (displayed canvas has no usable size), 'clipped' (canvas has a size but almost none of it is inside the visible container), 'black' (flat dark picture), 'flat' (one bright colour), 'ok', or 'unknown'. */
export function visibleVerdict(shown, stats, visible = shown) {
  if (!shown || shown.w < MIN_VISIBLE || shown.h < MIN_VISIBLE) return 'collapsed';
  if (!visible || visible.w < MIN_VISIBLE || visible.h < MIN_VISIBLE) return 'clipped';
  if (!stats || !stats.n) return 'unknown';
  if (stats.flat && stats.max < 40) return 'black';
  if (stats.flat) return 'flat';
  return 'ok';
}

/** Blank-for-the-UI: anything the viewer would show as nothing useful (collapsed counts, so 'blank:false' can no longer sit next to a black view). */
export const isBlankVerdict = (v) => v === 'collapsed' || v === 'clipped' || v === 'black';

/** Wrap a WebSocket-ish onmessage so the page can count bytes received (noVNC keeps no counter). */
export function countBytes(counter, handler) {
  return function (ev) { const d = ev && ev.data; counter.bytes += d ? (d.byteLength ?? d.size ?? d.length ?? 0) : 0; counter.msgs = (counter.msgs || 0) + 1; return handler ? handler.call(this, ev) : undefined; };
}
