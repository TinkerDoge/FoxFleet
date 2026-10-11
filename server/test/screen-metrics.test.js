import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fitScale, pickBox, checkDisplayed, scaleXY, lumaStats, visibleVerdict, isBlankVerdict, countBytes, MIN_VISIBLE } from '../../android/app/src/main/assets/viewmetrics.js';

const FB = { w: 1440, h: 900 };
test('fitScale contains a landscape fb in a portrait phone view', () => {
  const s = fitScale(1440, 900, 372, 662);
  assert.ok(Math.abs(s - 372 / 1440) < 1e-9);
  assert.equal(fitScale(0, 900, 372, 662), 0);
  assert.equal(fitScale(1440, 900, 0, 662), 0);
});
test('pickBox falls back to the window when the container is a ~2px sliver (the reported 2x1)', () => {
  assert.deepEqual(pickBox({ w: 2, h: 1.4 }, { w: 372, h: 662 }), { w: 372, h: 662, from: 'window' });
  assert.equal(pickBox({ w: 372, h: 600 }, { w: 372, h: 662 }).from, 'container');
  assert.equal(pickBox({ w: 0, h: 0 }, { w: 0, h: 0 }), null);
});
test('checkDisplayed flags the collapsed 2x1 canvas and accepts a proper fit', () => {
  const box = { w: 372, h: 662 };
  const bad = checkDisplayed({ w: 2, h: 1 }, FB, box);
  assert.ok(bad.collapsed && bad.wrong); assert.deepEqual(bad.expected, { w: 372, h: 233 });
  assert.deepEqual(checkDisplayed({ w: 372, h: 232.5 }, FB, box), { collapsed: false, wrong: false, expected: { w: 372, h: 233 } });
  assert.ok(checkDisplayed({ w: 200, h: 125 }, FB, box).wrong, 'a visible but far-too-small canvas is also refit');
  assert.equal(checkDisplayed(null, FB, null).wrong, false, 'no box -> nothing to fit into');
});
test('scaleXY reports each axis so a non-uniform scale is visible', () => {
  assert.equal(scaleXY({ w: 720, h: 900 }, FB), '0.5000x1.0000');
  assert.equal(scaleXY({ w: 2, h: 1 }, FB), '0.0014x0.0011');
});
const rgba = (...l) => Uint8ClampedArray.from(l.flatMap((v) => [v, v, v, 255]));
test('lumaStats + visibleVerdict: collapsed beats a painted backing store', () => {
  const painted = lumaStats(rgba(10, 200, 90, 255));
  assert.equal(visibleVerdict({ w: 2, h: 1 }, painted), 'collapsed', 'painted backing store but 2x1 shown = black screen');
  assert.equal(visibleVerdict({ w: 372, h: 233 }, painted), 'ok');
  assert.equal(visibleVerdict({ w: 372, h: 233 }, lumaStats(rgba(3, 3, 3, 4))), 'black');
  assert.equal(visibleVerdict({ w: 372, h: 233 }, lumaStats(rgba(200, 200, 201))), 'flat');
  assert.equal(visibleVerdict({ w: 372, h: 233 }, null), 'unknown');
  assert.equal(visibleVerdict(null, painted), 'collapsed');
  assert.ok(isBlankVerdict('collapsed') && isBlankVerdict('black') && !isBlankVerdict('ok') && !isBlankVerdict('flat') && !isBlankVerdict('unknown'));
  assert.ok(MIN_VISIBLE >= 8);
});
test('countBytes counts ArrayBuffer/Blob-like payloads and still calls the original handler', () => {
  const c = { bytes: 0 }; let got = 0;
  const h = countBytes(c, function (ev) { got += 1; return ev.data?.byteLength; });
  assert.equal(h({ data: new ArrayBuffer(100) }), 100); h({ data: { size: 5 } }); h({});
  assert.equal(c.bytes, 105); assert.equal(c.msgs, 3); assert.equal(got, 3);
});
test('screen.js uses the verdict (not a backing-store-only sample) and the asset reaches the APK check', () => {
  const js = fs.readFileSync(new URL('../../android/app/src/main/assets/screen.js', import.meta.url), 'utf8');
  assert.match(js, /from '\.\/viewmetrics\.js'/); assert.match(js, /visibleVerdict/); assert.doesNotMatch(js, /sampleBlank/);
});

import { intersect, intersectRect, MAX_SCALE } from '../../android/app/src/main/assets/viewmetrics.js';
test('clipped verdict: sized canvas with nothing inside the visible container is blank', () => {
  const canvas = { left: 0, top: 0, right: 412, bottom: 258 }, sliver = { left: 0, top: 0, right: 2, bottom: 1 };
  const vis = intersect(canvas, sliver); assert.deepEqual(vis, { w: 2, h: 1 });
  const painted = lumaStats(rgba(10, 200, 90, 255));
  assert.equal(visibleVerdict({ w: 412, h: 258 }, painted, vis), 'clipped');
  assert.equal(visibleVerdict({ w: 412, h: 258 }, painted, intersect(canvas, { left: 0, top: 0, right: 412, bottom: 915 })), 'ok');
  assert.equal(visibleVerdict({ w: 412, h: 258 }, painted, intersect(canvas, { left: 500, top: 0, right: 900, bottom: 900 })), 'clipped', 'disjoint');
  assert.ok(isBlankVerdict('clipped'));
  assert.deepEqual(intersectRect({ left: 5, top: 5, right: 10, bottom: 10 }, { left: 20, top: 0, right: 30, bottom: 30 }), { left: 20, top: 5, right: 20, bottom: 10 });
  assert.deepEqual(intersect(null, canvas), { w: 0, h: 0 });
});
test('fitScale is clamped and never NaN/negative', () => {
  assert.equal(fitScale(10, 10, 1e9, 1e9), MAX_SCALE);
  assert.equal(fitScale(Infinity, 10, 100, 100), 0); assert.equal(fitScale(NaN, 10, 100, 100), 0); assert.equal(fitScale(10, 10, -5, 100), 0);
  assert.equal(fitScale(1920, 1080, 1920, 1080), 1);
});
