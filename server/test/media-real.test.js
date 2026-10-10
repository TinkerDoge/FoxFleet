// MEDIA: tags from a REAL Hermes gateway (opt-in; needs HERMES_REAL_GATEWAY_TEST like ui-gateway.test.js, plus FAKE_LLM_PORT that the config points at).
// A fake model answers "send-media <path>" with `MEDIA:<path>`; the real gateway runs the turn, the hub turns the tag into a card link, and the
// bytes come back through the connector. This is also the proof that the gateway delivers the tag untouched (no media events exist in its protocol).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, REAL } from './ui-helpers.js';
import { fakeLlm } from './fake-llm.js';
import { waitFor } from './machine-helpers.js';
import { parseMedia } from '../media-tags.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('real gateway: a MEDIA: tag in the model reply reaches the hub as text and becomes a fetchable card', async (t) => {
  if (!REAL || !process.env.FAKE_LLM_PORT) return t.skip('set HERMES_REAL_GATEWAY_TEST and FAKE_LLM_PORT');
  const llm = fakeLlm(); await llm.listen(Number(process.env.FAKE_LLM_PORT)); t.after(() => llm.close());
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ff-real-media-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'tiny.png'); fs.writeFileSync(png, PNG);
  const x = await setup(t);
  const post = (route, data) => fetch(x.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const agent = (await waitFor(async () => { const a = (await (await fetch(x.base + '/api/agents')).json()).agents; return a.length && a[0].capabilities?.nativeUi ? a[0] : null; }, { tries: 200, ms: 200 })); assert.ok(agent);
  const chat = await post(`/api/agents/${agent.name}/chat`, { messages: [{ role: 'user', content: `send-media ${png}` }] }); assert.equal(chat.status, 200);
  const stream = await chat.text(); const text = [...stream.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');
  assert.ok(text.includes(`MEDIA:${png}`), 'the real gateway forwards the tag untouched: ' + text);
  assert.deepEqual(parseMedia(text).media.map((m) => [m.ref, m.kind]), [[png, 'image']]);
  const info = await (await post(`/api/agents/${agent.name}/media`, { ref: png })).json();
  const got = await fetch(x.base + info.url); assert.equal(got.status, 200); assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
});
