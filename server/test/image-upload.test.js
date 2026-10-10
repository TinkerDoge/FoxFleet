// A picture the user sends must reach the agent (native Hermes sessions used to turn it into the text "[image]") and survive in the transcript.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './ui-helpers.js';
import { waitFor } from './machine-helpers.js';
import { userImages } from '../index.js';
import { UI_OPS } from '../../connector/foxfleet-connector.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const url = `data:image/png;base64,${PNG}`;

test('userImages keeps only real base64 image data URLs, at most 4', () => {
  assert.deepEqual(userImages({ images: [url, 'https://x/y.png', 'data:text/html;base64,AAAA', 'javascript:1', url, url, url, url] }), [url, url, url, url]);
  assert.deepEqual(userImages(undefined), []);
});

test('connector op attachimg: rebuilt params, size and charset checks', () => {
  const [m, p] = UI_OPS.attachimg({ session_id: 's1', content_base64: PNG, ext: 'JPG', filename: '../../etc/passwd', evil: 1 });
  assert.equal(m, 'image.attach_bytes'); assert.deepEqual(p, { session_id: 's1', content_base64: PNG, ext: 'jpg', filename: '.._.._etc_passwd' });
  assert.throws(() => UI_OPS.attachimg({ session_id: 's1', content_base64: 'not base64!!' }), (e) => e.code === 'bad_params');
  assert.throws(() => UI_OPS.attachimg({ session_id: 's1' }), (e) => e.code === 'bad_params');
});

async function chatText(t, x, content) {
  const ac = new AbortController(), cap = setTimeout(() => ac.abort(), 15_000); t.after(() => { clearTimeout(cap); ac.abort(); });
  const r = await fetch(`${x.base}/api/agents/default/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }] }), signal: ac.signal });
  assert.equal(r.status, 200); let text = ''; try { for await (const c of r.body) { text += Buffer.from(c).toString(); if (text.includes('[DONE]')) break; } } catch { /* cap */ } clearTimeout(cap);
  return [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('') || text;
}
test('chat with a picture on a native session: Hermes gets the bytes with the turn (not "[image]" text)', async (t) => {
  const x = await setup(t);
  await waitFor(async () => { const a = (await (await fetch(x.base + '/api/agents')).json()).agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; }, { tries: 200, ms: 200 });
  const a = await chatText(t, x, [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url } }]);
  assert.match(a, /what is this\? \[with 1 image\(s\): 70 bytes\]/, a); assert.ok(!a.includes('[image]'), 'not the placeholder: ' + a);
  const b = await chatText(t, x, [{ type: 'image_url', image_url: { url } }]);
  assert.match(b, /Look at the attached image\. \[with 1 image/, b);
});
