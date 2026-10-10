import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMedia, parseStreaming, kindOf } from '../media-tags.js';

const { vectors } = JSON.parse(readFileSync(new URL('../../contract/media-tags.vectors.json', import.meta.url), 'utf8'));
for (const v of vectors) test(`media tags: ${v.name}`, () => {
  const r = parseMedia(v.input);
  assert.equal(r.text, v.text);
  assert.deepEqual(r.media.map((m) => ({ ref: m.ref, kind: m.kind, ...(m.voice ? { voice: true } : {}) })), v.media);
});
test('streaming hides a tag whose end has not arrived', () => {
  assert.equal(parseStreaming('Here it is MEDIA:/tmp/ch').text, 'Here it is');
  assert.equal(parseStreaming('Here [[audio_as').text, 'Here');
  assert.equal(parseStreaming('Done MEDIA:/tmp/a.png\nmore').text, 'Done\nmore');
});
test('a huge reply with thousands of tags is bounded', () => { const t = Array.from({ length: 5000 }, (_, i) => `MEDIA:/tmp/f${i}.png`).join('\n'); const r = parseMedia(t); assert.ok(r.media.length <= 24); });
test('kinds', () => { assert.equal(kindOf('/a/b.MOV'), 'video'); assert.equal(kindOf('/a/b.opus'), 'audio'); assert.equal(kindOf('https://x/y.png?z=1'), 'image'); assert.equal(kindOf('/a/b'), 'file'); });
test('pathological input is not slow', () => { const t = 'MEDIA:' + '/a b '.repeat(20000); const s = Date.now(); parseMedia(t); assert.ok(Date.now() - s < 1500); });
