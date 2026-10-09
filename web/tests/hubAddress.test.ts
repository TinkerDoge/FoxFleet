import { describe, expect, it } from 'vitest';
import { isLocalHost, normalizeHub, parseLink } from '../src/lib/hubAddress';

describe('normalizeHub', () => {
  it('adds https and keeps only the origin', () => { expect(normalizeHub('hub.example.com').url).toBe('https://hub.example.com'); expect(normalizeHub(' https://hub.example.com/ ').url).toBe('https://hub.example.com'); });
  it('refuses http for public hosts, even with the opt-in', () => { expect(normalizeHub('http://hub.example.com', true).error).toMatch(/https/); expect(normalizeHub('http://hub.example.com').error).toMatch(/https/); });
  it('allows http only for local hosts with the opt-in', () => {
    expect(normalizeHub('http://192.168.1.20:3080', true).url).toBe('http://192.168.1.20:3080');
    expect(normalizeHub('http://192.168.1.20:3080', false).error).toBeTruthy();
    expect(normalizeHub('localhost:3080', true).url).toBe('http://localhost:3080');
  });
  it('rejects paths, credentials, other schemes and empties', () => {
    for (const bad of ['https://hub.example.com/app', 'https://u:p@hub.example.com', 'ftp://hub.example.com', '', '   ', 'https://hub.example.com?x=1']) expect(normalizeHub(bad).error, bad).toBeTruthy();
  });
  it('classifies local hosts', () => { for (const h of ['localhost', '10.1.2.3', '172.20.0.1', '192.168.0.9', 'nas.local', 'box']) expect(isLocalHost(h), h).toBe(true); for (const h of ['hub.example.com', '8.8.8.8', '172.32.0.1']) expect(isLocalHost(h), h).toBe(false); });
});

describe('parseLink', () => {
  it('parses connect links with optional invite', () => {
    expect(parseLink('foxfleet://connect?hub=https://hub.example.com')).toEqual({ hub: 'https://hub.example.com' });
    expect(parseLink('foxfleet://connect?hub=https%3A%2F%2Fhub.example.com&invite=Xk2mQ9vTzR4nB7wLpA3')).toEqual({ hub: 'https://hub.example.com', invite: 'Xk2mQ9vTzR4nB7wLpA3' });
  });
  it('drops junk invites and unknown links', () => {
    expect(parseLink('foxfleet://connect?hub=https://h.example.com&invite=<script>')).toEqual({ hub: 'https://h.example.com' });
    expect(parseLink('foxfleet://other?hub=https://h.example.com')).toBeNull();
    expect(parseLink('foxfleet://connect?invite=abcdefghij')).toBeNull();
    expect(parseLink('')).toBeNull();
  });
  it('accepts a ?hub= query on a normal page URL', () => { expect(parseLink('?hub=https://hub.example.com&invite=abcdefgh12')).toEqual({ hub: 'https://hub.example.com', invite: 'abcdefgh12' }); expect(parseLink('?hub=javascript:alert(1)')).toBeNull(); });
});
