import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ICON_PATHS } from '../src/icons/paths';

const root = path.join(__dirname, '..', '..');
describe('icon set', () => {
  it('generated files match design/icons/icons.json (run node design/tools/gen-icons.mjs)', () => {
    expect(() => execFileSync('node', [path.join(root, 'design/tools/gen-icons.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
  });
  it('has the icons the app needs, all bundled as local path data (no CDN, no font download)', () => {
    for (const n of ['agents', 'chat', 'settings', 'attach', 'mic', 'send', 'stop', 'history', 'model', 'copy', 'retry', 'delete', 'rename', 'machine', 'user', 'logout', 'menu', 'more']) expect(ICON_PATHS, n).toHaveProperty(n);
    const css = readFileSync(path.join(root, 'web/src/styles/app.css'), 'utf8') + readFileSync(path.join(root, 'web/index.html'), 'utf8');
    expect(css).not.toMatch(/fonts\.googleapis|gstatic|cdn\./i);
  });
  it('the app does not draw its controls with text glyphs any more', () => {
    const src = readdirSync(path.join(root, 'web/src/chat')).filter((f) => f.endsWith('.tsx')).map((f) => readFileSync(path.join(root, 'web/src/chat', f), 'utf8')).join('\n');
    expect(src).not.toMatch(/>[＋↑■🎤⋯✕]</);
  });
});
