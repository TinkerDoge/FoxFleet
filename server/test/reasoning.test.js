// Reasoning: one shape for every provider, never in the visible reply, and the native gateway's events.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { thinkSplitter, normaliseChunk, normaliseSse } from '../reasoning.js';
import { normalise } from '../hermes-ui.js';
import { toFrames } from '../native-facade.js';

const V = JSON.parse(fs.readFileSync(new URL('../../contract/reasoning.vectors.json', import.meta.url), 'utf8'));
const sse = (deltas, finish = true) => deltas.map((d, i) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, ...(finish && i === deltas.length - 1 ? { finish_reason: 'stop' } : {}) }] })}\n\n`).join('') + 'data: [DONE]\n\n';
async function run(body, slice = 0) {
  const bytes = new TextEncoder().encode(body), chunks = slice ? Array.from({ length: Math.ceil(bytes.length / slice) }, (_, i) => bytes.slice(i * slice, (i + 1) * slice)) : [bytes];
  const out = await new Response(normaliseSse(new ReadableStream({ start(c) { for (const b of chunks) c.enqueue(b); c.close(); } }))).text();
  let content = '', reasoning = ''; for (const m of out.matchAll(/^data: (\{.*\})$/gm)) { const d = JSON.parse(m[1]).choices?.[0]?.delta ?? {}; content += d.content ?? ''; reasoning += d.reasoning_content ?? ''; }
  return { content, reasoning, out };
}

for (const c of V.cases) {
  test(`vector: ${c.name}`, async () => {
    const whole = await run(sse(c.deltas)); assert.equal(whole.content, c.content); assert.equal(whole.reasoning, c.reasoning); assert.ok(!/<\/?think(ing)?>/.test(whole.content) || /<b>/.test(c.content), 'no think tag in the reply');
    const bytewise = await run(sse(c.deltas), 7); assert.equal(bytewise.content, c.content, 'arbitrary network chunking'); assert.equal(bytewise.reasoning, c.reasoning);
    assert.ok(whole.out.trimEnd().endsWith('data: [DONE]'));
  });
}

test('thinkSplitter works one character at a time', () => {
  const s = thinkSplitter(); let content = '', reasoning = ''; for (const ch of 'a<think>b</think>\nc') { const r = s.push(ch); content += r.content; reasoning += r.reasoning; } const f = s.flush(); content += f.content; reasoning += f.reasoning;
  assert.equal(content, 'ac'); assert.equal(reasoning, 'b');
});

test('non-chat frames and bad JSON pass through untouched', async () => {
  const body = 'event: hermes.tool.progress\ndata: {"tool":"x"}\n\n: keep-alive\n\ndata: not json\n\n';
  assert.equal((await run(body)).out, body);
});

test('native gateway: reasoning.delta streams, reasoning.available does not repeat it, thinking.delta is only a spinner, message.complete.reasoning is the fallback', () => {
  const s = { stored: 's1' }; normalise({ type: 'message.start', payload: {} }, s);
  const events = (types) => types.map(([type, payload]) => normalise({ type, payload }, s)).filter(Boolean);
  let ev = events([['thinking.delta', { text: 'pondering...' }], ['reasoning.delta', { text: 'First, ' }], ['reasoning.delta', { text: 'second.' }], ['reasoning.available', { text: 'First, second.' }], ['message.delta', { text: 'Hi' }], ['message.complete', { text: 'Hi', reasoning: 'First, second.' }]]);
  assert.deepEqual(ev.map((e) => e.type), ['reasoning', 'reasoning', 'message.delta', 'turn.end']); assert.equal(ev[0].text + ev[1].text, 'First, second.'); assert.equal(ev[3].reasoning, undefined, 'already streamed');
  assert.deepEqual(ev.slice(0, 2).flatMap(toFrames).map((b) => JSON.parse(new TextDecoder().decode(b).slice(6)).choices[0].delta.reasoning_content), ['First, ', 'second.']);
  normalise({ type: 'message.start', payload: {} }, s);
  ev = events([['reasoning.available', { text: 'whole block' }], ['message.complete', { text: 'ok' }]]); assert.deepEqual(ev.map((e) => e.type), ['reasoning', 'turn.end']);
  normalise({ type: 'message.start', payload: {} }, s);
  ev = events([['message.complete', { text: 'ok', reasoning: 'only at the end' }]]); assert.equal(ev[0].reasoning, 'only at the end');
  assert.match(new TextDecoder().decode(toFrames(ev[0])[0]), /"reasoning_content":"only at the end"/);
});

test('chunks keep their other fields (tool calls, usage, ids)', () => {
  const o = normaliseChunk({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0 }], content: '' } }], usage: { total_tokens: 3 } }, thinkSplitter());
  assert.equal(o.id, 'c1'); assert.deepEqual(o.usage, { total_tokens: 3 }); assert.deepEqual(o.choices[0].delta.tool_calls, [{ index: 0 }]);
});
