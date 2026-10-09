import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/api/client';
import { fromHistory } from '../src/lib/chat';
import { renderMarkdown } from '../src/lib/markdown';
import { ago } from '../src/lib/time';

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
// What the hub returns for a Hermes session after it normalised the raw rows (see server/test/history.test.js).
const HUB = { messages: [
  { role: 'user', content: 'What is in this picture?\n\n📎 /tmp/report.pdf', images: ['data:image/png;base64,AAAA'], ts: 1790000001500 },
  { role: 'assistant', content: 'It shows **a red fox**:\n\n| trait | value |\n|---|---|\n| color | red |\n\n```py\nprint("fox")\n```', reasoning: 'Fox. Answer briefly.', tools: [{ name: 'vision_analyze', args: 'image: /tmp/x.png', result: '{"success": true}', ok: true }, { name: 'terminal', ok: false }], ts: 1790000004000 },
  { role: 'tool', content: '{"raw":"json"}' }, { role: 'system', content: 'x' }, { role: 'assistant', content: '' }, null,
], has_more: true };

describe('history through the rich pipeline', () => {
  it('maps hub history into UI messages: tools, reasoning, images, time; drops tool/system/empty rows', async () => {
    const f = vi.fn(async () => json(HUB)); const page = await createClient({ fetch: f as never }).messages('atlas', 's1', { limit: 40, offset: 80 });
    expect(page.hasMore).toBe(true); expect(page.messages).toHaveLength(2); expect(String(f.mock.calls[0]).includes('limit=40&offset=80')).toBe(true);
    const [u, a] = page.messages; expect(u.images?.[0].dataUrl).toMatch(/^data:image\/png/); expect(u.ts).toBe(1790000001500);
    expect(a.tools).toHaveLength(2); expect(a.tools![1].ok).toBe(false); expect(a.reasoning).toBe('Fox. Answer briefly.');
  });
  it('old messages render exactly like live ones (markdown table, code block, no raw JSON)', () => {
    const a = fromHistory(HUB.messages[1])!; const html = renderMarkdown(a.content);
    expect(html).toContain('<table'); expect(html).toContain('<pre'); expect(html).not.toContain('"success"');
    expect(renderMarkdown('<img src=x onerror=alert(1)>[x](javascript:alert(1))')).not.toMatch(/onerror|javascript:/i);
  });
  it('fromHistory tolerates junk', () => { expect(fromHistory(null)).toBeNull(); expect(fromHistory({ role: 'tool', content: 'x' })).toBeNull(); expect(fromHistory({ role: 'assistant', content: 5 })).toBeNull(); expect(fromHistory({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' }); });
  it('session list carries title, time, preview; rename/delete use PATCH/DELETE', async () => {
    const f = vi.fn(async (u: string, i?: RequestInit) => (i?.method === 'PATCH' || i?.method === 'DELETE' ? json({ ok: true }) : json({ sessions: [{ id: 'a', title: 'Plan', updated: 1790000000000, preview: 'hello', messages: 4 }], total: 31 })));
    const c = createClient({ fetch: f as never }); const p = await c.sessions('atlas', { offset: 30 }); expect(p.total).toBe(31); expect(p.sessions[0]).toMatchObject({ preview: 'hello', messages: 4, updated: 1790000000000 }); expect(String(f.mock.calls[0][0])).toContain('offset=30');
    await c.renameSession('atlas', 'a', 'New'); expect(f.mock.calls.at(-1)![1]!.method).toBe('PATCH'); await c.deleteSession('atlas', 'a'); expect(f.mock.calls.at(-1)![1]!.method).toBe('DELETE');
  });
  it('relative times', () => { const now = 1_800_000_000_000; expect(ago(now - 5_000, now)).toBe('just now'); expect(ago(now - 5 * 60_000, now)).toBe('5 min ago'); expect(ago(now - 26 * 3600_000, now)).toBe('yesterday'); expect(ago(undefined, now)).toBe(''); });
});
