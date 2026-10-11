import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBackground } from '../src/chat/ChatBackground';
import { BackgroundPicker } from '../src/chat/BackgroundPicker';
import { Composer } from '../src/chat/Composer';
import { draftKey } from '../src/chat/drafts';
import { resetChats } from '../src/chat/store';
import { DEFAULT_BG, normalizeBg, PATTERNS, SOLIDS, type ChatBg } from '../src/lib/chatBg';
import type { Client } from '../src/api/client';
import type { AgentSummary } from '../src/api/types';

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); resetChats(); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); });

describe('ChatBackground layer', () => {
  it('draws nothing for the default look', async () => { await act(() => render(<ChatBackground bg={DEFAULT_BG} />, host)); expect(host.querySelector('.chat-bg')).toBeNull(); });
  it('draws a themed solid, a masked pattern with the token opacity, and a blurred/dimmed picture', async () => {
    await act(() => render(<ChatBackground bg={normalizeBg({ mode: 'solid', solid: 'sage' })} />, host));
    expect((host.querySelector('.chat-bg-fill') as HTMLElement).style.background).toContain('--chat-solid-sage');
    await act(() => render(<ChatBackground bg={normalizeBg({ mode: 'pattern', pattern: 'paws', solid: 'sand' })} />, host));
    const pat = host.querySelector('.chat-bg-pattern') as HTMLElement; expect(pat.style.getPropertyValue('--pat-o')).toContain('--chat-pattern-paws-opacity'); expect(pat.getAttribute('style')).toContain('mask-image');
    await act(() => render(<ChatBackground bg={normalizeBg({ mode: 'image', image: true, blur: 10, dim: 0.4 })} url="blob:x" />, host));
    expect((host.querySelector('.chat-bg-img') as HTMLElement).style.filter).toBe('blur(10px)'); expect((host.querySelector('.chat-bg-dim') as HTMLElement).style.opacity).toBe('0.4');
    expect(host.querySelector('.chat-bg')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('BackgroundPicker', () => {
  function show(bg: ChatBg, over: Partial<Parameters<typeof BackgroundPicker>[0]> = {}) {
    const calls = { change: vi.fn(), pick: vi.fn(), reset: vi.fn(), close: vi.fn() };
    return act(() => render(<BackgroundPicker bg={bg} hasImage={bg.image} error={false} onChange={calls.change} onPick={calls.pick} onReset={calls.reset} onClose={calls.close} {...over} />, host)).then(() => calls);
  }
  it('offers default / colour / pattern / picture as a labelled radio group and switches type', async () => {
    const c = await show(DEFAULT_BG);
    const radios = [...host.querySelectorAll('[role=radiogroup][aria-label="Background type"] [role=radio]')]; expect(radios.map((r) => r.textContent)).toEqual(['Default', 'Colour', 'Pattern', 'Picture']);
    await act(() => (radios[1] as HTMLElement).click()); expect(c.change).toHaveBeenCalledWith(expect.objectContaining({ mode: 'solid', solid: SOLIDS[0].id }));
    await act(() => (radios[2] as HTMLElement).click()); expect(c.change).toHaveBeenLastCalledWith({ mode: 'pattern' });
  });
  it('lists every pattern and colour with a name, and reports the choice', async () => {
    const c = await show(normalizeBg({ mode: 'pattern', pattern: 'dots', solid: 'sage' }));
    const pats = [...host.querySelectorAll('.bg-swatches.patterns [role=radio]')]; expect(pats).toHaveLength(PATTERNS.length); pats.forEach((p) => expect(p.getAttribute('aria-label')).toBeTruthy());
    await act(() => (host.querySelector('[aria-label="Foxes"]') as HTMLElement).click()); expect(c.change).toHaveBeenCalledWith({ pattern: 'foxes' });
    await act(() => (host.querySelector('.bg-swatches:not(.patterns) [aria-label="Sky"]') as HTMLElement).click()); expect(c.change).toHaveBeenCalledWith({ solid: 'sky' });
  });
  it('blur and dim are labelled sliders that change live; reset and close work; Escape closes', async () => {
    const c = await show(normalizeBg({ mode: 'image', image: true, blur: 4, dim: 0.3 }));
    const blur = host.querySelector('#bg-blur') as HTMLInputElement, dim = host.querySelector('#bg-dim') as HTMLInputElement;
    expect(host.querySelector('label[for=bg-blur]')!.textContent).toBe('Blur'); expect(blur.value).toBe('4'); expect(dim.value).toBe('30');
    await act(() => { blur.value = '15'; blur.dispatchEvent(new Event('input', { bubbles: true })); }); expect(c.change).toHaveBeenCalledWith({ blur: 15 });
    await act(() => { dim.value = '60'; dim.dispatchEvent(new Event('input', { bubbles: true })); }); expect(c.change).toHaveBeenCalledWith({ dim: 0.6 });
    await act(() => (host.querySelector('.bg-actions .btn.text') as HTMLElement).click()); expect(c.reset).toHaveBeenCalled();
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); expect(c.close).toHaveBeenCalled();
    expect(host.textContent).toContain('Never uploaded');
  });
  it('reset is disabled when there is nothing to reset; picking a file hands it to the app', async () => {
    const c = await show(DEFAULT_BG); expect((host.querySelector('.bg-actions .btn.text') as HTMLButtonElement).disabled).toBe(true);
    const input = host.querySelector('input[type=file]') as HTMLInputElement; const f = new File(['x'], 'p.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [f] }); await act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); }); expect(c.pick).toHaveBeenCalledWith(f);
  });
});

describe('attachment menu icons', () => {
  const agent: AgentSummary = { id: 'a', name: 'a', kind: 'hermes', online: true, chatReady: true, capabilities: { images: true, files: true, voice: false } };
  it('every attach action has an icon, a text label and a 44 px-friendly button', async () => {
    const key = draftKey('a');
    await act(() => render(<Composer key={key} draftKey={key} client={{} as Client} agent={agent} history={[]} streaming={false} skills={[]} onSend={() => {}} onStop={() => {}} onLocal={() => {}} />, host));
    const trigger = host.querySelector<HTMLButtonElement>('.attach button[aria-label="Attach"]')!; expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    await act(() => trigger.click());
    const items = [...host.querySelectorAll<HTMLElement>('[role=menuitem]')];
    expect(items.map((i) => i.textContent)).toEqual(['Photo library', 'Take photo', 'File']);
    for (const i of items) { const svg = i.querySelector('svg.icon'); expect(svg, i.textContent!).not.toBeNull(); expect(svg!.getAttribute('aria-hidden')).toBe('true'); }
  });
});
