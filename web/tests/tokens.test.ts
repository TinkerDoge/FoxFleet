import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
describe('design tokens', () => {
  it('generated CSS and Kotlin are up to date with design/tokens.json', () => {
    expect(() => execFileSync('node', ['../design/tools/gen-tokens.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
