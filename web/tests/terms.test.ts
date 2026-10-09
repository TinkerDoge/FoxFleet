import { describe, expect, it } from 'vitest';
import { PRIVACY_URL, TERMS_URL, rememberTerms, termsAccepted } from '../src/lib/terms';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe('terms acceptance', () => {
  it('is remembered per hub and per version', () => {
    const s = mem();
    expect(termsAccepted('https://a.example', '1.0', s)).toBe(false);
    rememberTerms('https://a.example', '1.0', s);
    expect(termsAccepted('https://a.example', '1.0', s)).toBe(true);
    expect(termsAccepted('https://b.example', '1.0', s)).toBe(false);
    expect(termsAccepted('https://a.example', '2.0', s)).toBe(false);
  });
  it('does not throw when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(termsAccepted('h', '1.0', broken)).toBe(false);
    expect(() => rememberTerms('h', '1.0', broken)).not.toThrow();
  });
  it('links to the hosted legal pages', () => {
    expect(TERMS_URL).toBe('https://tinkerdoge.github.io/FoxFleet/legal/terms');
    expect(PRIVACY_URL).toBe('https://tinkerdoge.github.io/FoxFleet/legal/privacy');
  });
});
