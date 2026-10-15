import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/api/client';
import type { Client, StreamOpts } from '../src/api/client';
import { chatOf, resetChats, send } from '../src/chat/store';
import { forgetAll } from '../src/lib/persist';

const enc = new TextEncoder();
const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const replace = (text: string) => `event: foxfleet.replace\ndata: ${JSON.stringify({ text })}\n\n`;
const sse = (chunks: string[]) => { const q = [...chunks]; return new Response(new ReadableStream({ pull(c) { const x = q.shift(); if (x !== undefined) c.enqueue(enc.encode(x)); else c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': 'fc_AAAAAAAAAAAAAAAA' } }); };
beforeEach(() => { resetChats(); forgetAll(); });

describe('bot replies that replace what was streamed', () => {
  it('the client reports a foxfleet.replace event with the whole text and keeps reading', async () => {
    const client = createClient({ fetch: (async () => sse([delta('Hel▉'), replace('Hello'), delta(' there'), 'data: [DONE]\n\n'])) as never });
    const seen: string[] = [];
    await client.chat('helper', [{ role: 'user', content: 'hi' }], { onContent: (d) => seen.push(`+${d}`), onReplace: (t) => seen.push(`=${t}`), onReasoning() {}, onTool() {}, onSession() {} });
    expect(seen).toEqual(['+Hel▉', '=Hello', '+ there']);
  });
  it('the chat store ends with the replaced text, not the streamed draft followed by the replacement', async () => {
    const chat = vi.fn(async (_agent: string, _history: unknown, opts: StreamOpts) => { opts.onContent('Hel▉'); opts.onReplace?.('Hello'); expect(chatOf('helper').streamText).toBe('Hello'); opts.onContent(' world'); return 'fc_AAAAAAAAAAAAAAAA'; });
    const c = { chat, runs: vi.fn(async () => []), queue: vi.fn(async () => ({ items: [], recent: [], activeRun: null, halted: false, openRequests: [], canCancel: false, modes: [] })), sessions: vi.fn(async () => ({ sessions: [], total: 0 })), messages: vi.fn(async () => ({ messages: [], hasMore: false })) } as unknown as Client;
    await send(c, 'helper', 'hi', [], [], () => {});
    const last = chatOf('helper').messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'Hello world' });
  });
});
