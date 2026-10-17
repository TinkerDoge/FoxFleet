// Notification reply tokens (0.4.0-alpha, docs/LIVE-EVENTS.md "Reply token"): a short-lived credential that lets a notification's
// direct-reply / mark-read action work without the app's session, and nothing else. Stateless: HMAC-SHA256 over
// { user, device, agent, chat, expiry } with a per-hub key (reply-token.key in the data directory, mode 0600). Minted per device
// stream when an event is pushed, never written to the notification log. The caller still checks that the device is signed in.
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

export const REPLY_TOKEN_TTL_MS = 24 * 3600_000;
const LABEL = 'foxfleet.reply.v1.';

export async function replyTokens(keyFile, { now = () => Date.now(), ttlMs = REPLY_TOKEN_TTL_MS } = {}) {
  let key = null;
  try { const raw = (await readFile(keyFile, 'utf8')).trim(); if (/^[A-Za-z0-9_-]{43}$/.test(raw)) key = Buffer.from(raw, 'base64url'); } catch { /* first run */ }
  if (!key) { key = randomBytes(32); await writeFile(keyFile, key.toString('base64url'), { mode: 0o600 }); }
  const sign = (payload) => createHmac('sha256', key).update(LABEL + payload).digest('base64url');
  return {
    /** { token, expires_at } for one device, agent and chat. */
    mint({ user, device, agent, chat }) {
      const e = now() + ttlMs, payload = Buffer.from(JSON.stringify({ v: 1, u: user, d: device, a: agent, c: chat, e })).toString('base64url');
      return { token: `${payload}.${sign(payload)}`, expires_at: e };
    },
    /** The token's claims, or null when it is malformed, forged or expired. */
    verify(token) {
      if (typeof token !== 'string' || token.length > 512) return null;
      const m = /^([A-Za-z0-9_-]{8,460})\.([A-Za-z0-9_-]{43})$/.exec(token); if (!m) return null;
      const want = Buffer.from(sign(m[1])), got = Buffer.from(m[2]);
      if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
      let c; try { c = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
      if (!c || c.v !== 1 || typeof c.u !== 'string' || typeof c.d !== 'string' || typeof c.a !== 'string' || typeof c.c !== 'string' || !Number.isFinite(c.e) || c.e <= now()) return null;
      return { user: c.u, device: c.d, agent: c.a, chat: c.c, expires: c.e };
    },
  };
}
