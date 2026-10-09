import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/router';
describe('router', () => {
  it('parses hash routes', () => { expect(parseRoute('').name).toBe('agents'); const r = parseRoute('#/chat?agent=A&session=s1'); expect(r.name).toBe('chat'); expect(r.params.get('agent')).toBe('A'); });
});
