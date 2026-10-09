import { describe, expect, it } from 'vitest';
import { navigate, parseRoute } from '../src/router';
describe('router', () => {
  it('parses hash routes', () => { expect(parseRoute('').name).toBe('agents'); const r = parseRoute('#/chat?agent=A&session=s1'); expect(r.name).toBe('chat'); expect(r.params.get('agent')).toBe('A'); });

  it('profile names with slashes, colons, @, spaces and + survive navigate -> parse, and navigating to the current route does not loop', () => {
    for (const name of ['work', 'team/ops', 'a:b', 'me@host', 'two words', 'c++', 'ünï', '100%']) {
      navigate('chat', { agent: name, session: 's:1/2' }); const r = parseRoute(location.hash); expect(r.name).toBe('chat'); expect(r.params.get('agent')).toBe(name); expect(r.params.get('session')).toBe('s:1/2');
      let fired = 0; const on = () => { fired++; }; addEventListener('hashchange', on); navigate('chat', { agent: name, session: 's:1/2' }); removeEventListener('hashchange', on); expect(fired).toBe(0);
    }
  });
});
