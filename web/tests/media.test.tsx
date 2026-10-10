import { render } from 'preact';
import { act } from 'preact/test-utils';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { parseMedia } from '../src/lib/mediaTags';
import { AssistantText } from '../src/chat/Message';
import { MediaContext, type Resolved } from '../src/chat/MediaCards';
import { createClient } from '../src/api/client';

const { vectors } = JSON.parse(readFileSync(pathResolve(__dirname, '../../contract/media-tags.vectors.json'), 'utf8'));
it.each(vectors.map((v: any) => [v.name, v]) as [string, any][])('conformance: %s', (_n: string, v: any) => {
  const r = parseMedia(v.input);
  expect(r.text).toBe(v.text);
  expect(r.media.map((m) => ({ ref: m.ref, kind: m.kind, ...(m.voice ? { voice: true } : {}) }))).toEqual(v.media);
});

let host: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
beforeEach(() => { host = document.createElement('div'); document.body.append(host); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); });
const draw = (text: string, resolve: (ref: string) => Promise<Resolved>, streaming = false, onMedia = vi.fn()) => act(() => render(<MediaContext.Provider value={resolve}><AssistantText text={text} onMedia={onMedia} streaming={streaming} /></MediaContext.Provider>, host));

it('strips the tags from the text and shows an image, a video, a voice note and a file card', async () => {
  const res = vi.fn(async (ref: string): Promise<Resolved> => ({ url: '/api/media/t-' + ref.split('/').pop(), kind: ref.endsWith('.png') ? 'image' : ref.endsWith('.mp4') ? 'video' : ref.endsWith('.ogg') ? 'audio' : 'file', name: ref.split('/').pop()! }));
  await draw('Here you go\nMEDIA:/tmp/a.png\nMEDIA:/tmp/v.mp4\n[[audio_as_voice]]\nMEDIA:/tmp/s.ogg\nMEDIA:/tmp/r.pdf', res); await flush();
  expect(host.textContent).not.toContain('MEDIA:'); expect(host.textContent).toContain('Here you go');
  expect(host.querySelector('.media-card.image img')?.getAttribute('src')).toBe('/api/media/t-a.png');
  expect(host.querySelector('.media-card.video video')?.getAttribute('src')).toBe('/api/media/t-v.mp4');
  expect(host.querySelector('.media-card.audio.voice audio')?.getAttribute('src')).toBe('/api/media/t-s.ogg');
  const file = host.querySelector<HTMLAnchorElement>('a.media-card.file')!; expect(file.getAttribute('href')).toBe('/api/media/t-r.pdf'); expect(file.hasAttribute('download')).toBe(true);
});

it('clicking a picture opens the fullscreen viewer; remote pictures use the image proxy without asking the hub', async () => {
  const res = vi.fn(async (): Promise<Resolved> => ({ url: '/api/media/x', kind: 'image', name: 'a.png' })), onMedia = vi.fn();
  await draw('MEDIA:/tmp/a.png\nMEDIA:https://example.com/p.jpg', res, false, onMedia); await flush();
  expect(res).toHaveBeenCalledTimes(1); expect(res).toHaveBeenCalledWith('/tmp/a.png');
  const imgs = host.querySelectorAll<HTMLImageElement>('.media-card.image img'); expect(imgs[1].getAttribute('src')).toBe('/api/media-proxy?url=' + encodeURIComponent('https://example.com/p.jpg'));
  await act(() => { host.querySelector<HTMLButtonElement>('button.media-card.image')!.click(); }); expect(onMedia).toHaveBeenCalledWith({ kind: 'image', src: '/api/media/x', alt: 'a.png' });
});

it('a card that is asked for a moment before the hub has seen the reply retries, then shows; a real failure shows a retry button', async () => {
  let n = 0; const e404 = Object.assign(new Error('nope'), { status: 404 });
  const res = vi.fn(async (): Promise<Resolved> => { if (++n < 3) throw e404; return { url: '/api/media/ok', kind: 'image', name: 'a.png' }; });
  await act(() => render(<MediaContext.Provider value={res}><AssistantText text="MEDIA:/tmp/a.png" onMedia={() => {}} /></MediaContext.Provider>, host));
  await act(async () => { await new Promise((r) => setTimeout(r, 1700)); }); await flush(); expect(host.querySelector('.media-card.image img')).toBeTruthy(); expect(n).toBe(3);
  const bad = vi.fn(async (): Promise<Resolved> => { throw Object.assign(new Error('refused'), { status: 403 }); });
  await draw('MEDIA:/etc/x.png', bad); await flush(); expect(host.querySelector('.media-card.muted')?.textContent).toContain('Not available'); expect(host.querySelector('.media-card.muted button')).toBeTruthy();
}, 15000);

it('while streaming, a half-written tag is hidden', async () => { await draw('Look MEDIA:/tmp/ch', async () => { throw new Error('x'); }, true); expect(host.textContent?.trim()).toBe('Look'); });

it('client.media returns the hub link and refuses anything that is not a hub media path', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ url: '/api/media/abc.def', kind: 'video', name: 'v.mp4' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  expect(await createClient({ fetch: f as never }).media('a', '/tmp/v.mp4')).toEqual({ url: '/api/media/abc.def', kind: 'video', name: 'v.mp4' }); expect(JSON.parse(String((f.mock.calls[0] as any)[1].body))).toEqual({ ref: '/tmp/v.mp4' });
  const evil = vi.fn(async () => new Response(JSON.stringify({ url: 'https://evil.example/x', kind: 'image', name: 'x' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await expect(createClient({ fetch: evil as never }).media('a', '/tmp/x.png')).rejects.toThrow();
});

it('a tag echoed into the reasoning block is not shown either', async () => {
  const { Message } = await import('../src/chat/Message');
  await act(() => render(<MediaContext.Provider value={async () => { throw new Error('x'); }}><Message m={{ role: 'assistant', content: 'ok', reasoning: 'thinking\nMEDIA:/tmp/a.png\n[[audio_as_voice]]' } as never} onMedia={() => {}} grouped={false} /></MediaContext.Provider>, host));
  expect(host.querySelector('.reasoning')?.textContent).not.toMatch(/MEDIA:|\[\[/); expect(host.querySelector('.reasoning')?.textContent).toContain('thinking');
});
