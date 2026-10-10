import { beforeEach, describe, expect, it } from 'vitest';
import { forgetLast, previewOf, rememberLast, setLastScope, withLocalLast } from '../src/lib/localLast';
import { hubIsOld, missingFeatures } from '../src/lib/hubCompat';

beforeEach(() => { localStorage.clear(); setLastScope('u1'); });
const agent = (o: object = {}) => ({ name: 'a', last_activity_at: null, last_message_preview: null, last_role: null, ...o }) as any;

describe('local last message fallback', () => {
  it('fills a blank row from what this device sent or received', () => {
    rememberLast('a', 'user', 'hello **there**', 1000); const r = withLocalLast(agent());
    expect(r).toMatchObject({ last_activity_at: 1000, last_message_preview: 'hello there', last_role: 'user' });
  });
  it('the hub wins when it is newer, this device wins when it is newer', () => {
    rememberLast('a', 'assistant', 'local reply', 5000);
    expect(withLocalLast(agent({ last_activity_at: 9000, last_message_preview: 'hub', last_role: 'user' })).last_message_preview).toBe('hub');
    expect(withLocalLast(agent({ last_activity_at: 1000, last_message_preview: 'old hub' })).last_message_preview).toBe('local reply');
  });
  it('a hub row with a time but no preview still gets the local text', () => { rememberLast('a', 'assistant', 'x', 1000); expect(withLocalLast(agent({ last_activity_at: 1000 })).last_message_preview).toBe('x'); });
  it('stays blank when nothing is known, scopes per user, and forgets on sign-out', () => {
    expect(withLocalLast(agent())).toEqual(agent()); rememberLast('a', 'user', 'mine', 1); setLastScope('u2'); expect(withLocalLast(agent()).last_message_preview).toBeNull();
    setLastScope('u1'); forgetLast(); expect(withLocalLast(agent()).last_message_preview).toBeNull();
  });
  it('previews drop MEDIA tags, code and images, and are one short line', () => {
    expect(previewOf('Here\nMEDIA:/tmp/a.png\n![x](http://a/b.png) done')).toBe('Here [image] done');
    expect(previewOf('a'.repeat(300)).length).toBe(140);
  });
});
describe('hub compatibility', () => {
  it('a hub that reports nothing is old; a current one is not', () => {
    expect(hubIsOld(undefined)).toBe(true);
    expect(missingFeatures({ version: '0.3.5-alpha', features: ['agentActivity', 'media', 'screenErrors', 'mediaTags'] })).toEqual([]);
    expect(missingFeatures({ version: '0.3.5-alpha', features: ['media'] })).toContain('agentActivity');
  });
});
