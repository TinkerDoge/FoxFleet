import test from 'node:test';
import assert from 'node:assert/strict';
import { toFrames } from '../native-facade.js';
test('tool lifecycle carries stable identity and completion while preserving legacy progress and media', () => {
  const decode = e => toFrames(e).map(x => new TextDecoder().decode(x));
  const started = decode({ type: 'tool.start', turn_id: 't', tool_id: 'a', name: 'web_search' });
  assert.ok(started.some(x => x.includes('event: foxfleet.tool') && x.includes('"tool_id":"a"')));
  assert.ok(started.some(x => x.includes('event: hermes.tool.progress')));
  const ended = decode({ type: 'tool.end', turn_id: 't', tool_id: 'a', name: 'web_search', media: [{ ref: '/tmp/a.png' }] });
  assert.ok(ended.some(x => x.includes('event: foxfleet.tool') && x.includes('"type":"tool.end"')));
  assert.ok(ended.some(x => x.includes('MEDIA:/tmp/a.png')));
});
