import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, commandSuggestions, localCommandFor, opensCommandBrowser, parseLocal, unavailableReason } from '../src/lib/commands';
import { composeWithFiles, humanSize, splitFiles } from '../src/lib/files';
import { chatMessages } from '../src/lib/chat';

const skills = ['review', 'research', 'deploy-notes', 'translate'];
describe('command autocomplete', () => {
  it('offers useful commands on bare "/", with skills, and leaves aliases and unavailable commands out', () => {
    const all = commandSuggestions('/', skills, Number.POSITIVE_INFINITY); const l = all.map((s) => s.label);
    expect(BUNDLED_CATALOG.commands.length).toBeGreaterThan(90);
    for (const n of ['/new', '/compress', '/model', '/help', '/usage', '/memory', '/skills', '/reasoning', '/deploy-notes']) expect(l, n).toContain(n);
    for (const n of ['/clear', '/reset', '/compact', '/palette']) expect(l, n).not.toContain(n);
    expect(l.indexOf('/deploy-notes')).toBeGreaterThan(l.indexOf('/new')); expect(l.indexOf('/deploy-notes')).toBeLessThan(l.indexOf('/model'));
    expect(new Set(all.map((s) => s.group)).size).toBeGreaterThan(3); expect(commandSuggestions('/', skills).length).toBe(12);
    expect(all.find((s) => s.label === '/model')).toMatchObject({ group: 'Configuration', availability: 'chat' }); expect(all.find((s) => s.label === '/new')).toMatchObject({ local: 'new', availability: 'app' });
  });
  it('still finds aliases and unavailable commands by name, and searches descriptions when the name does not match', () => {
    expect(commandSuggestions('/reset', [], 20)[0]).toMatchObject({ label: '/reset', local: 'new' });
    const clear = commandSuggestions('/cl', [], 20).find((s) => s.label === '/clear')!; expect(clear.availability).toBe('unavailable'); expect(clear.hint).toMatch(/Terminal|terminal/);
    expect(unavailableReason('/clear')).toBeTruthy(); expect(unavailableReason('/new')).toBeUndefined(); expect(unavailableReason('hello')).toBeUndefined();
    expect(commandSuggestions('/comp', [], 20).map((s) => s.label)).toEqual(expect.arrayContaining(['/compress', '/compact']));
    expect(commandSuggestions('/', [], Number.POSITIVE_INFINITY).find((s) => s.label === '/compress')?.args).toMatch(/here/);
    expect(commandSuggestions('/token', [], 20).map((s) => s.label)).toContain('/usage');
    expect(commandSuggestions('/', [], Number.POSITIVE_INFINITY, true, undefined, true).some((s) => s.label === '/clear')).toBe(true);
    expect(opensCommandBrowser('/help')).toBe(true); expect(opensCommandBrowser('/palette')).toBe(true); expect(opensCommandBrowser('/help skills')).toBe(false);
  });
  it('filters by prefix, including aliases', () => {
    expect(commandSuggestions('/re', skills, 50).map((s) => s.label)).toEqual(expect.arrayContaining(['/reasoning', '/retry', '/reset', '/review', '/research']));
    expect(commandSuggestions('/comp', [], 20).map((s) => s.label)).toEqual(expect.arrayContaining(['/compress', '/compact']));
  });
  it('offers skills on "#" with prefix matches first', () => {
    expect(commandSuggestions('#re', skills).map((s) => s.label)).toEqual(['#review', '#research']);
    expect(commandSuggestions('#notes', skills).map((s) => s.label)).toEqual(['#deploy-notes']);
  });
  it('only triggers for the first word', () => {
    expect(commandSuggestions('hello', skills)).toEqual([]); expect(commandSuggestions('/new now', skills)).toEqual([]); expect(commandSuggestions('', skills)).toEqual([]);
  });
  it('non-Hermes agents never see Hermes commands or skills', () => {
    expect(commandSuggestions('/', [], 50, false).map((s) => s.label)).toEqual(['/new', '/sessions', '/stop']);
    expect(commandSuggestions('/mo', ['model-x'], 50, false)).toEqual([]); expect(commandSuggestions('#mo', ['model-x'], 50, false)).toEqual([]); expect(parseLocal('/retry', false)).toBeUndefined();
  });
  it('detects commands Foxfleet runs itself, with arguments only where they make sense', () => {
    expect(localCommandFor(' /new ')).toBe('new'); expect(localCommandFor('/stop')).toBe('stop'); expect(localCommandFor('/history')).toBe('sessions'); expect(localCommandFor('/retry')).toBe('retry');
    expect(parseLocal('/title Weekly plan')).toEqual({ cmd: 'title', args: 'Weekly plan' }); expect(parseLocal('/title')).toBeUndefined(); expect(parseLocal('/new now')).toBeUndefined();
    expect(localCommandFor('/newer')).toBeUndefined(); expect(localCommandFor('/usage')).toBeUndefined();
  });
  it('a hub-served catalog replaces the bundled one', () => {
    const cat = { commands: [{ name: 'zap', aliases: [], description: 'Zap it', category: 'Session', args: '<x>', subcommands: [], availability: 'chat' as const }] };
    expect(commandSuggestions('/', [], 10, true, cat).map((s) => s.label)).toEqual(['/zap']);
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
