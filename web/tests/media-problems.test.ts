import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { allowCommand, dirOfRef, mediaProblem } from '../src/chat/mediaProblems';

describe('media problems (shared vectors)', () => {
  const vectors = JSON.parse(readFileSync('../contract/media-problems.vectors.json', 'utf8'));
  for (const v of vectors.cases) it(JSON.stringify(v.in), () => expect(mediaProblem(v.in)).toBe(v.kind));
});
describe('one-tap fix', () => {
  it('shares the file\'s own folder, never for URLs', () => {
    expect(dirOfRef('/home/u/work/out/a.png')).toBe('/home/u/work/out');
    expect(allowCommand('/home/u/work/out/a.png')).toBe('foxfleet connector allow-media "/home/u/work/out"');
    expect(allowCommand('https://x.example/a.png')).toBe('');
  });
});
