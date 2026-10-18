// Agent media for chat: MEDIA:/path or MEDIA:https://... in a reply becomes an image/video/audio/file card.
//   - The hub remembers which refs an agent mentioned, per user and agent (note). Nothing else can be fetched through it.
//   - resolve() turns a mentioned ref into a short-lived, user-bound token URL: /api/media/<token>.
//   - serve() streams the bytes to that user only: local files come from the machine's connector (which enforces roots, type and size),
//     URLs through the SSRF-guarded fetcher. Results sit in a small size-bounded cache so replays and range requests are cheap.
//   - revoke() forgets a ref forever (a durable, per scope+agent tombstone), so a transcript reload cannot resurrect it and old tokens 404.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fault } from './config.js';
import { parseMedia, kindOf, nameOf, isUrl, isData, DELIVERABLE } from './media-tags.js';
import { fetchImage, MEDIA_TYPES } from './media-proxy.js';

const b64 = (b) => Buffer.from(b).toString('base64url');
const INLINE = /^(image\/(png|jpeg|gif|webp|bmp|avif)|video\/(mp4|webm|quicktime)|audio\/|application\/pdf$)/;

export function mediaHub({ connectors, fetchUrl = fetchImage, now = () => Date.now(), tokenTtlMs = 15 * 60_000, mentionTtlMs = 7 * 24 * 3600_000, cacheBytes = 64 * 1024 * 1024, maxBytes = 25 * 1024 * 1024, maxMentions = 400, revokePath } = {}) {
  const secret = randomBytes(32), mentioned = new Map(), cache = new Map(), revoked = new Map(); let cached = 0; // cache: key -> { body, mime, name, at }
  const key = (scope, agent) => `${scope}\0${agent}`;
  const rkey = (scope, agent, ref) => `${scope}\0${agent}\0${ref}`;
  const sign = (body) => b64(createHmac('sha256', secret).update(body).digest());

  // Durable revocations survive a restart: a transcript reload re-notes the old reply, so forgetting only RAM would resurrect it.
  if (revokePath) {
    let data;
    try { data = JSON.parse(readFileSync(revokePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (data && data.v === 1 && Array.isArray(data.rows)) for (const r of data.rows) {
      if (r && typeof r.scope === 'string' && typeof r.agent === 'string' && typeof r.ref === 'string' && Number.isFinite(r.at)) revoked.set(rkey(r.scope, r.agent, r.ref), r.at);
    }
  }
  // Atomic writes (temp + rename, 0600), serialized so concurrent revokes never interleave.
  let revokePending = Promise.resolve();
  function persist() {
    if (!revokePath) return Promise.resolve();
    const rows = [...revoked].map(([k, at]) => { const [scope, agent, ref] = k.split('\0'); return { scope, agent, ref, at }; });
    const tmp = `${revokePath}.${randomBytes(6).toString('hex')}.tmp`;
    const job = revokePending.then(async () => {
      await mkdir(path.dirname(revokePath), { recursive: true });
      try { await writeFile(tmp, JSON.stringify({ v: 1, rows }), { mode: 0o600, flag: 'wx' }); await rename(tmp, revokePath); }
      finally { await unlink(tmp).catch(() => {}); }
    });
    revokePending = job.catch(() => {}); // keep the serial queue alive after a failed write
    return job;
  }

  /** Remember every ref in this reply text (so a client may later ask for exactly these). `at` is the message's own timestamp. */
  function note(scope, agent, text, at) {
    if (typeof text !== 'string' || (!text.includes('MEDIA:') && !text.includes('](') && !text.includes('http'))) return 0;
    const refs = parseMedia(text).media.map((m) => m.ref).filter((r) => !isData(r)); if (!refs.length) return 0; // data: pictures carry their own bytes: nothing to fetch, nothing to remember
    const k = key(scope, agent), bag = mentioned.get(k) ?? mentioned.set(k, new Map()).get(k), t = now();
    // 3-arg (live/test) uses now(); an explicit undefined/NaN timestamp from a transcript row is 0 so it cannot look "newer" than a tombstone.
    const when = Number.isFinite(at) ? at : (arguments.length < 4 ? t : 0);
    let dropped = false;
    for (const r of refs) {
      const rv = revoked.get(rkey(scope, agent, r));
      if (rv !== undefined && when <= rv) continue; // still revoked: an old mention of a deleted file stays dead
      if (rv !== undefined) { revoked.delete(rkey(scope, agent, r)); dropped = true; } // a newer reply re-offered it
      bag.delete(r); bag.set(r, t); // re-insert = most recent last
    }
    for (const [r, seen] of bag) { if (bag.size <= maxMentions && t - seen < mentionTtlMs) break; bag.delete(r); }
    if (dropped) void persist();
    return refs.length;
  }
  const knows = (scope, agent, ref) => { const at = mentioned.get(key(scope, agent))?.get(ref); return at !== undefined && now() - at < mentionTtlMs && !revoked.has(rkey(scope, agent, ref)); };

  /** Forget a ref forever: drop any mention, its byte cache, and persist the tombstone. Idempotent. */
  async function revoke({ scope, agent, ref, at = now() }) {
    ref = String(ref ?? '').trim(); if (!ref) return false;
    revoked.set(rkey(scope, agent, ref), at);
    const bag = mentioned.get(key(scope, agent)); if (bag) bag.delete(ref);
    for (const [ck, entry] of cache) if (ck.includes(ref)) { cached -= entry.body.length; cache.delete(ck); }
    await persist();
    return true;
  }
  /** When a ref was revoked for this scope+agent (ms), or null when it is live. */
  const revokedAt = (scope, agent, ref) => revoked.get(rkey(scope, agent, ref)) ?? null;

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
    if (revoked.has(rkey(v.s, v.a, v.r))) throw fault(404, 'That file was not offered by this agent');
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
  return { note, knows, resolve, serve, open, revoke, revoked: revokedAt, _cache: () => ({ entries: cache.size, bytes: cached }) };
}
