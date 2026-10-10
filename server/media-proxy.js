// Remote Markdown images are fetched by the hub, never by the browser, so the page CSP can stay `img-src 'self' data: blob:`
// and the reader's IP, cookies and referrer never reach third-party servers. SSRF protections:
//   https only, port 443 only, no credentials in the URL; every hop (including redirects, max 2) is resolved by us and
//   refused unless EVERY resolved address is public; the socket is pinned to the validated address (no DNS rebinding);
//   only raster image types (never SVG), 8 MB cap, 10 s total timeout, no cookies sent, response re-served with nosniff + sandbox CSP.
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fault } from './config.js';

export const MAX_BYTES = 8 * 1024 * 1024, TIMEOUT_MS = 10_000, MAX_REDIRECTS = 2;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
/** What an agent's MEDIA:https://... tag may deliver through the hub (never HTML, SVG or scripts). */
export const MEDIA_TYPES = new Set([...IMAGE_TYPES, 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/flac', 'audio/aac', 'application/pdf', 'text/plain', 'text/csv', 'application/zip']);

const v4 = (ip) => ip.split('.').map(Number);
const inV4 = (n, base, bits) => { const a = (n[0] * 2 ** 24) + (n[1] << 16) + (n[2] << 8) + n[3], b = v4(base), c = (b[0] * 2 ** 24) + (b[1] << 16) + (b[2] << 8) + b[3], size = 2 ** (32 - bits); return Math.floor(a / size) === Math.floor(c / size); };
const BLOCK4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];

/** True only for globally routable addresses. Anything unparsable is refused. */
export function isPublicIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return !BLOCK4.some(([b, bits]) => inV4(v4(ip), b, bits));
  if (kind !== 6) return false;
  const s = ip.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}(?:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(s) || /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPublicIp(mapped[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); return isPublicIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
  if (s === '::' || s === '::1') return false;
  const first = parseInt(s.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false; // ULA, link-local, multicast
  if (s.startsWith('64:ff9b:') || s.startsWith('2001:db8') || s.startsWith('2002:') || s.startsWith('2001:0:') || s.startsWith('100:')) return false; // NAT64, docs, 6to4, Teredo, discard
  return (first & 0xe000) === 0x2000; // only global unicast 2000::/3
}

export function parseTarget(raw) {
  let u; try { u = new URL(String(raw)); } catch { throw fault(400, 'Invalid image URL'); }
  if (u.protocol !== 'https:') throw fault(400, 'Only https images can be proxied');
  if (u.username || u.password) throw fault(400, 'Invalid image URL');
  if (u.port && u.port !== '443') throw fault(400, 'Only the default https port is allowed');
  if (!u.hostname || u.hostname.length > 253) throw fault(400, 'Invalid image URL');
  return u;
}

async function pin(hostname, lookup) {
  const literal = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(literal) ? [{ address: literal, family: net.isIP(literal) }] : await lookup(hostname, { all: true, verbatim: true }).catch(() => { throw fault(502, 'Image host not found'); });
  if (!addrs.length || !addrs.every((a) => isPublicIp(a.address))) throw fault(403, 'That address is not allowed');
  return addrs[0];
}

/** Fetches one image through the protections above. `lookup`/`request` are injectable for tests. */
export async function fetchImage(raw, { lookup = dns.lookup, request = https.request, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, types = IMAGE_TYPES } = {}) {
  const deadline = Date.now() + timeoutMs; let target = parseTarget(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const addr = await pin(target.hostname, lookup);
    const res = await new Promise((resolve, reject) => {
      const left = deadline - Date.now(); if (left <= 0) return reject(fault(504, 'Image request timed out'));
      const req = request({ host: addr.address, family: addr.family, port: 443, method: 'GET', path: target.pathname + target.search, servername: net.isIP(target.hostname) ? undefined : target.hostname,
        headers: { Host: target.host, Accept: types === IMAGE_TYPES ? 'image/png,image/jpeg,image/gif,image/webp,image/avif' : [...types].join(','), 'User-Agent': 'Foxfleet-media-proxy', 'Accept-Encoding': 'identity' }, timeout: left }, resolve);
      req.on('timeout', () => req.destroy(fault(504, 'Image request timed out'))); req.on('error', (e) => reject(e.status ? e : fault(502, 'Could not fetch the image'))); req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume(); if (hop === MAX_REDIRECTS) throw fault(502, 'Too many redirects');
      try { target = parseTarget(new URL(res.headers.location, target)); } catch (e) { throw fault(e.status ?? 400, e.message); }
      continue;
    }
    if (res.statusCode !== 200) { res.resume(); throw fault(502, 'The image host refused the request'); }
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!types.has(type)) { res.resume(); throw fault(415, 'Not a supported media type'); }
    if (Number(res.headers['content-length']) > maxBytes) { res.resume(); throw fault(413, 'Image is too large'); }
    const chunks = []; let size = 0;
    for await (const c of res) { size += c.length; if (size > maxBytes) { res.destroy(); throw fault(413, 'Image is too large'); } chunks.push(c); }
    return { type, body: Buffer.concat(chunks) };
  }
  throw fault(502, 'Too many redirects');
}
