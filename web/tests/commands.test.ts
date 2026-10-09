import { describe, expect, it } from 'vitest';
import { commandSuggestions, localCommandFor } from '../src/lib/commands';
import { composeWithFiles, humanSize, splitFiles } from '../src/lib/files';
import { chatMessages } from '../src/lib/chat';

const skills = ['review', 'research', 'deploy-notes', 'translate'];
describe('command autocomplete', () => {
  it('offers commands and skills on "/"', () => {
    const l = commandSuggestions('/', skills, 20).map((s) => s.label);
    expect(l).toContain('/new'); expect(l).toContain('/review'); expect(commandSuggestions('/', skills).length).toBe(8);
    expect(commandSuggestions('/re', skills).map((s) => s.label)).toEqual(['/reasoning', '/review', '/research']);
  });
  it('offers skills on "#" with prefix matches first', () => {
    expect(commandSuggestions('#re', skills).map((s) => s.label)).toEqual(['#review', '#research']);
    expect(commandSuggestions('#notes', skills).map((s) => s.label)).toEqual(['#deploy-notes']);
  });
  it('only triggers for the first word', () => {
    expect(commandSuggestions('hello', skills)).toEqual([]); expect(commandSuggestions('/new now', skills)).toEqual([]); expect(commandSuggestions('', skills)).toEqual([]);
  });
  it('non-Hermes kinds only get local commands', () => {
    expect(commandSuggestions('/', [], 8, false).map((s) => s.label)).toEqual(['/new', '/sessions', '/stop']);
  });
  it('detects exact local commands', () => {
    expect(localCommandFor(' /new ')).toBe('new'); expect(localCommandFor('/stop')).toBe('stop'); expect(localCommandFor('/newer')).toBeUndefined(); expect(localCommandFor('/usage')).toBeUndefined();
  });
});
describe('files and chat payload', () => {
  it('round-trips attached-file markers', () => {
    const text = composeWithFiles('look', [{ name: 'a.txt', path: 'uploads/a.txt', size: 2048 }]);
    expect(text).toBe('look\n\n[Attached file: uploads/a.txt (2 KB)]'); expect(splitFiles(text)).toEqual({ text: 'look', files: [{ path: 'uploads/a.txt', size: '2 KB' }] });
    expect(humanSize(5 * 1048576)).toBe('5 MB'); expect(humanSize(1536)).toBe('1.5 KB');
  });
  it('sends image bytes only on the newest user turn', () => {
    const m = chatMessages([{ role: 'user', content: 'a', images: [{ dataUrl: 'data:1' }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'b', images: [{ dataUrl: 'data:2' }] }]) as any[];
    expect(m[0].content).toBe('[image] a'); expect(m[2].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:2' } });
  });
});
