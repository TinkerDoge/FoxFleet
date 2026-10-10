// Media a tool produced (image_generate, text_to_speech, send_message, screenshots, file writers) becomes MEDIA: lines so every client shows a card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolMedia, withMediaLines, parseMedia } from '../media-tags.js';
import { normalise } from '../hermes-ui.js';
import { normalizeTranscript } from '../transcript.js';

const vectors = JSON.parse(readFileSync(new URL('../../contract/tool-media.vectors.json', import.meta.url), 'utf8'));
for (const c of vectors.cases) test(`toolMedia: ${c.name}`, () => assert.deepEqual(toolMedia(c.tool, c.args, c.result).map((m) => m.ref), c.refs));

test('withMediaLines appends only refs the reply does not carry', () => {
  assert.equal(withMediaLines('Here you go', ['/a/x.png']), 'Here you go\n\nMEDIA:/a/x.png');
  assert.equal(withMediaLines('Here\nMEDIA:/a/x.png', ['/a/x.png']), 'Here\nMEDIA:/a/x.png');
  assert.equal(withMediaLines('See /a/x.png', ['/a/x.png']), 'See /a/x.png', 'a bare path already in the text is not duplicated');
  assert.equal(withMediaLines('', ['/a/x.png', 'https://h.example/v.mp4']), 'MEDIA:/a/x.png\nMEDIA:https://h.example/v.mp4');
  assert.deepEqual(parseMedia(withMediaLines('hi', ['/a/x.png'])).media.map((m) => m.ref), ['/a/x.png']);
});

test('native turn: a tool.complete with a media result adds a delta and the final text carries the MEDIA line', () => {
  const s = { stored: 's1', turn: null, running: false, partial: '' };
  normalise({ type: 'message.start', payload: {} }, s);
  const done = normalise({ type: 'tool.complete', payload: { tool_id: 't1', name: 'image_generate', args: { prompt: 'fox' }, result: { success: true, image: '/home/u/.hermes/cache/images/fox.png' } } }, s);
  assert.equal(done.type, 'tool.end'); assert.deepEqual(done.media.map((m) => m.ref), ['/home/u/.hermes/cache/images/fox.png']);
  const end = normalise({ type: 'message.complete', payload: { text: 'Here is your fox.' } }, s);
  assert.equal(end.text, 'Here is your fox.\n\nMEDIA:/home/u/.hermes/cache/images/fox.png');
  const s2 = { stored: 's2', turn: null, running: false, partial: '' }; normalise({ type: 'message.start', payload: {} }, s2);
  normalise({ type: 'tool.complete', payload: { tool_id: 't', name: 'read_file', args: { path: '/a/p.png' }, result: { content: 'x' } } }, s2);
  assert.equal(normalise({ type: 'message.complete', payload: { text: 'ok' } }, s2).text, 'ok');
});

test('history: tool results in a stored transcript add MEDIA lines to the reply that follows them', () => {
  const rows = [
    { role: 'user', content: 'draw a fox' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'image_generate', arguments: '{"prompt":"fox"}' } }] },
    { role: 'tool', tool_call_id: 'c1', tool_name: 'image_generate', content: '{"success": true, "image": "/home/u/.hermes/cache/images/fox.png"}' },
    { role: 'assistant', content: 'Done!' },
  ];
  const out = normalizeTranscript(rows), last = out.at(-1);
  assert.equal(last.role, 'assistant'); assert.match(last.content, /^Done!\n\nMEDIA:\/home\/u\/\.hermes\/cache\/images\/fox\.png$/);
  assert.equal(normalizeTranscript(rows.slice(0, 3)).at(-1).content.includes('MEDIA:'), true, 'a turn that ends on the tool result still shows it');
});
