// Agent media for chat: MEDIA:/path or MEDIA:https://... in a reply becomes an image/video/audio/file card.
//   - The hub remembers which refs an agent mentioned, per user and agent (note). Nothing else can be fetched through it.
//   - resolve() turns a mentioned ref into a short-lived, user-bound token URL: /api/media/<token>.
//   - serve() streams the bytes to that user only: local files come from the machine's connector (which enforces roots, type and size),
//     URLs through the SSRF-guarded fetcher. Results sit in a small size-bounded cache so replays and range requests are cheap.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fault } from './config.js';
import { parseMedia, kindOf, nameOf, isUrl, DELIVERABLE } from './media-tags.js';
import { fetchImage, MEDIA_TYPES } from './media-proxy.js';

const b64 = (b) => Buffer.from(b).toString('base64url');
const INLINE = /^(image\/(png|jpeg|gif|webp|bmp|avif)|video\/(mp4|webm|quicktime)|audio\/|application\/pdf$)/;

export function mediaHub({ connectors, fetchUrl = fetchImage, now = () => Date.now(), tokenTtlMs = 15 * 60_000, mentionTtlMs = 7 * 24 * 3600_000, cacheBytes = 64 * 1024 * 1024, maxBytes = 25 * 1024 * 1024, maxMentions = 400 } = {}) {
  const secret = randomBytes(32), mentioned = new Map(), cache = new Map(); let cached = 0; // cache: key -> { body, mime, name, at }
  const key = (scope, agent) => `${scope}\0${agent}`;
  const sign = (body) => b64(createHmac('sha256', secret).update(body).digest());

  /** Remember every ref in this reply text (so a client may later ask for exactly these). */
  function note(scope, agent, text) {
    if (typeof text !== 'string' || (!text.includes('MEDIA:') && !text.includes('](') && !text.includes('http'))) return 0;
    const refs = parseMedia(text).media.map((m) => m.ref); if (!refs.length) return 0;
    const k = key(scope, agent), bag = mentioned.get(k) ?? mentioned.set(k, new Map()).get(k), t = now();
    for (const r of refs) { bag.delete(r); bag.set(r, t); } // re-insert = most recent last
    for (const [r, at] of bag) { if (bag.size <= maxMentions && t - at < mentionTtlMs) break; bag.delete(r); }
    return refs.length;
  }
  const knows = (scope, agent, ref) => { const at = mentioned.get(key(scope, agent))?.get(ref); return at !== undefined && now() - at < mentionTtlMs; };

  /** { url, kind, name } for a ref this user's agent mentioned; 404 otherwise (the same answer for "never mentioned" and "not yours"). */
  function resolve({ scope, agent, machineId, profile, ref }) {
    ref = String(ref ?? '').trim(); if (!ref || ref.length > 2000 || !knows(scope, agent, ref)) throw fault(404, 'That file was not offered by this agent');
    const kind = kindOf(ref), url = isUrl(ref), ext = (/\.([A-Za-z0-9]{1,8})$/.exec(ref.split(/[?#]/)[0]) ?? [])[1]?.toLowerCase() ?? '';
    if (!url && !machineId) throw fault(404, 'This agent cannot deliver local files');
    if (!url && !DELIVERABLE.has(ext)) throw fault(415, 'This file type is not delivered');
    const p = b64(JSON.stringify({ s: scope, a: agent, m: machineId ?? null, f: profile ?? null, r: ref, e: now() + tokenTtlMs }));
    return { url: `/api/media/${p}.${sign(p)}`, kind, name: nameOf(ref), source: url ? 'url' : 'machine', expires: now() + tokenTtlMs };
  }
  function open(token, scope) {
    const [p, sig] = String(token ?? '').split('.'); if (!p || !sig) throw fault(404, 'Not found');
    const want = Buffer.from(sign(p)), got = Buffer.from(sig); if (want.length !== got.length || !timingSafeEqual(want, got)) throw fault(404, 'Not found');
    let v; try { v = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { throw fault(404, 'Not found'); }
    if (v.s !== scope) throw fault(404, 'Not found'); // someone else's link: indistinguishable from a missing one
    if (!(v.e > now())) throw fault(410, 'This link expired; reopen the chat to get a fresh one');
    return v;
  }
  function remember(k, entry) {
    if (entry.body.length > cacheBytes / 2) return;
    if (cache.has(k)) cached -= cache.get(k).body.length;
    cache.set(k, entry); cached += entry.body.length;
    for (const [ck, c] of cache) { if (cached <= cacheBytes) break; cache.delete(ck); cached -= c.body.length; }
  }
  async function load(v) {
    const k = `${v.m ?? 'url'}\0${v.f ?? ''}\0${v.r}`, hit = cache.get(k);
    if (hit && now() - hit.at < 5 * 60_000) { cache.delete(k); cache.set(k, hit); return hit; }
    let entry;
    if (isUrl(v.r)) { const r = await fetchUrl(v.r, { types: MEDIA_TYPES, maxBytes }); entry = { body: r.body, mime: r.type, name: nameOf(v.r), at: now() }; }
    else { const r = await connectors.fetchMedia(v.m, v.f ?? v.a, v.r, { maxBytes }); entry = { body: r.body, mime: r.mime, name: r.name, at: now() }; }
    remember(k, entry); return entry;
  }
  /** Writes the file to `res` (full body or one byte range). */
  async function serve({ token, scope, req, res }) {
    const v = open(token, scope), e = await load(v), size = e.body.length;
    const headers = { 'Content-Type': e.mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=300', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition': `${INLINE.test(e.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(e.name)}` };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      let a = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]), b = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (a > b || a >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 }); return res.end(req.method === 'HEAD' ? undefined : e.body.subarray(a, b + 1));
    }
    res.writeHead(200, { ...headers, 'Content-Length': size }); res.end(req.method === 'HEAD' ? undefined : e.body);
  }
  return { note, knows, resolve, serve, open, _cache: () => ({ entries: cache.size, bytes: cached }) };
}
