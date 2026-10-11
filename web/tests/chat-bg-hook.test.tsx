import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageStore } from '../src/lib/chatBg';

const store: ImageStore & { map: Map<string, Blob> } = { map: new Map(), get: async (k) => store.map.get(k), put: async (k, b) => { store.map.set(k, b); }, delete: async (k) => { store.map.delete(k); }, clear: async () => { store.map.clear(); } };
vi.mock('../src/lib/chatBg', async (orig) => ({ ...(await orig<typeof import('../src/lib/chatBg')>()), images: () => store, downscaleBackground: async (f: Blob) => f }));
const { useChatBg } = await import('../src/chat/ChatBackground');

let host: HTMLDivElement, api: ReturnType<typeof useChatBg>;
const Probe = ({ k }: { k: string }) => { api = useChatBg(k); return null; };
let n = 0; const made: string[] = [], revoked: string[] = [];
beforeEach(() => {
  localStorage.clear(); store.map.clear(); made.length = 0; revoked.length = 0; host = document.createElement('div'); document.body.append(host);
  URL.createObjectURL = () => { const u = `blob:t${++n}`; made.push(u); return u; }; URL.revokeObjectURL = (u: string) => { revoked.push(u); };
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); });

describe('useChatBg object URLs', () => {
  it('revokes the URL made by pick() when a new picture replaces it, and on unmount', async () => {
    await act(() => render(<Probe k="a\0s1" />, host));
    await act(async () => { await api.pick(new File(['1'], 'a.png', { type: 'image/png' })); });
    await act(async () => { await api.pick(new File(['2'], 'b.png', { type: 'image/png' })); });
    expect(made.length).toBe(2); expect(revoked).toEqual([made[0]]);
    await act(() => render(null, host));
    expect(revoked).toEqual([made[0], made[1]]);
  });
  it('revokes the picked URL when the chat changes', async () => {
    await act(() => render(<Probe k="a\0s1" />, host));
    await act(async () => { await api.pick(new File(['1'], 'a.png', { type: 'image/png' })); });
    await act(() => render(<Probe k="a\0s2" />, host)); await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(revoked).toContain(made[0]);
  });
});
