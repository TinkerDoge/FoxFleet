import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { control, createFollow, step } from '../src/chat/scrollFollow';

const vectors = JSON.parse(readFileSync('../contract/scroll-follow.vectors.json', 'utf8'));
describe('scroll follow (shared vectors)', () => {
  for (const c of vectors.cases) it(c.name, () => {
    const f = createFollow();
    for (const s of c.steps) {
      const { expect: want, ...ev } = s, got = step(f, ev), view = { ...got, control: control(got) };
      for (const [k, v] of Object.entries(want)) expect((view as Record<string, unknown>)[k], `${JSON.stringify(ev)} -> ${k}`).toBe(v);
    }
  });
});
