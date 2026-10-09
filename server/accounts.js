// User accounts, devices (sessions) and invites. Passwords are scrypt-hashed; session tokens are
// random, stored only as SHA-256, bound to a device row the user can list and revoke.
// TOTP: users carry a nullable `totp` slot and login accepts an optional `code`; enrolment comes later.
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fault } from './config.js';

const scryptAsync = promisify(scrypt);
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 32;
const sha = (v) => createHash('sha256').update(v).digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export const DAY = 86400_000;
export const SESSION_AGE = 30 * DAY, ROTATE_AFTER = DAY, GRACE = 60_000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), KEYLEN, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export const validUsername = (u) => typeof u === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(u);
export function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 10) throw fault(400, 'Password must be at least 10 characters');
  if (p.length > 256) throw fault(400, 'Password is too long');
}

export async function accountStore(dir, { now = () => Date.now() } = {}) {
  await mkdir(dir, { recursive: true });
  const file = (n) => path.join(dir, n);
  const load = async (n, fallback) => { try { return JSON.parse(await readFile(file(n), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw fault(500, 'Invalid account data'); } };
  const users = new Map((await load('users.json', { users: [] })).users.map((u) => [u.id, u]));
  const sessions = new Map((await load('devices.json', { devices: [] })).devices.map((d) => [d.id, d]));
  const invites = new Map((await load('invites.json', { invites: [] })).invites.map((i) => [i.id, i]));
  let settings = { registration: 'closed', ...(await load('account-settings.json', {})) };
  let pending = Promise.resolve();
  const save = (name, value) => { const work = pending.then(async () => { const tmp = file(name) + '.' + randomUUID() + '.tmp'; try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(tmp, file(name)); } catch { await rm(tmp, { force: true }).catch(() => {}); throw fault(500, 'Could not save account data'); } }); pending = work.catch(() => {}); return work; };
  const persist = {
    users: () => save('users.json', { users: [...users.values()] }),
    devices: () => save('devices.json', { devices: [...sessions.values()] }),
    invites: () => save('invites.json', { invites: [...invites.values()] }),
    settings: () => save('account-settings.json', settings),
  };
  const fails = new Map(); // key -> { count, until, lockedUntil }
  const failKey = (kind, v) => kind + ':' + String(v).toLowerCase();
  function throttle(key, limit, windowMs, lockMs) {
    const t = now(), f = fails.get(key);
    if (f?.lockedUntil > t) throw Object.assign(fault(429, 'Too many attempts. Try again later.'), { retryAfter: Math.ceil((f.lockedUntil - t) / 1000) });
    return { fail() { const cur = fails.get(key) && fails.get(key).until > t ? fails.get(key) : { count: 0, until: t + windowMs }; cur.count++; if (cur.count >= limit) { cur.lockedUntil = t + lockMs; } fails.set(key, cur); }, clear() { fails.delete(key); } };
  }
  const byName = (name) => [...users.values()].find((u) => u.username.toLowerCase() === String(name).toLowerCase());
  const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role, totp: Boolean(u.totp), disabled: Boolean(u.disabled), created: u.created, acceptedTerms: u.terms?.version ?? null });
  const dummy = await hashPassword('dummy-password-for-timing');
  const newToken = (sid) => { const secret = randomBytes(32).toString('base64url'); return { token: `${sid}.${secret}`, hash: sha(secret) }; };
  function prune() { const t = now(); let changed = false; for (const [id, s] of sessions) if (s.expires <= t) { sessions.delete(id); changed = true; } for (const [id, i] of invites) if (i.expires <= t || i.usedBy) { if (i.expires <= t) { invites.delete(id); } } return changed; }

  const api = {
    needsSetup: () => users.size === 0,
    userCount: () => users.size,
    users: () => [...users.values()].map(publicUser),
    user: (id) => users.has(id) ? publicUser(users.get(id)) : null,
    registration: () => settings.registration,
    async setRegistration(mode, userId) { if (!['closed', 'invite', 'open'].includes(mode)) throw fault(400, 'Invalid registration mode'); if (users.get(userId)?.role !== 'owner') throw fault(403, 'Owner only'); settings = { ...settings, registration: mode }; await persist.settings(); },
    async createUser(username, password, role = 'user', { skipPolicy = false, terms = null } = {}) {
      if (!validUsername(username)) throw fault(400, 'Username: 3–32 letters, digits, . _ -');
      if (!skipPolicy) checkPassword(password);
      if (byName(username)) throw fault(409, 'That username is taken');
      if (users.size >= 1000) throw fault(400, 'User limit reached');
      const u = { id: randomBytes(8).toString('hex'), username, pass: await hashPassword(password), role, created: now(), totp: null, ...(terms ? { terms: { version: terms, at: now() } } : {}) };
      users.set(u.id, u); await persist.users(); return publicUser(u);
    },
    async verify(username, password, ip, code) {
      const ipLimit = throttle(failKey('ip', ip), 30, 10 * 60_000, 10 * 60_000), userLimit = throttle(failKey('user', username || ''), 5, 15 * 60_000, 15 * 60_000);
      const u = typeof username === 'string' && typeof password === 'string' && password.length <= 1024 ? byName(username) : undefined;
      const ok = await verifyPassword(typeof password === 'string' ? password.slice(0, 1024) : '', u ? u.pass : dummy);
      if (!u || !ok) { ipLimit.fail(); userLimit.fail(); throw fault(401, 'Wrong username or password'); }
      if (u.disabled) throw fault(403, 'This account is disabled');
      if (u.totp) throw fault(401, 'Two-factor code required'); // reserved for TOTP enrolment (not enabled yet)
      userLimit.clear(); return publicUser(u);
    },
    async createSession(userId, meta = {}) {
      prune();
      if ([...sessions.values()].filter((s) => s.userId === userId).length >= 50) { const oldest = [...sessions.values()].filter((s) => s.userId === userId).sort((a, b) => a.lastSeen - b.lastSeen)[0]; sessions.delete(oldest.id); }
      const id = randomBytes(8).toString('hex'), { token, hash } = newToken(id), t = now();
      sessions.set(id, { id, userId, hash, prevHash: null, prevUntil: 0, created: t, rotated: t, lastSeen: t, expires: t + SESSION_AGE, name: String(meta.name || 'Device').slice(0, 64), kind: meta.kind === 'app' ? 'app' : 'web', ip: meta.ip || '', ua: String(meta.ua || '').slice(0, 160) });
      await persist.devices(); return { token, deviceId: id };
    },
    // Returns { user, device, rotated?: token } or null. Tokens older than a day rotate on use (old one lives 60 s for in-flight requests).
    async authenticate(token) {
      if (typeof token !== 'string' || token.length > 200) return null;
      const dot = token.indexOf('.'); if (dot < 1) return null;
      const s = sessions.get(token.slice(0, dot)); if (!s) return null;
      const h = sha(token.slice(dot + 1)), t = now();
      if (s.expires <= t) { sessions.delete(s.id); await persist.devices(); return null; }
      const current = eq(s.hash, h), previous = s.prevHash && s.prevUntil > t && eq(s.prevHash, h);
      if (!current && !previous) return null;
      const user = users.get(s.userId); if (!user || user.disabled) return null;
      const out = { user: publicUser(user), device: s.id };
      s.lastSeen = t;
      if (current && t - s.rotated > ROTATE_AFTER) { const n = newToken(s.id); s.prevHash = s.hash; s.prevUntil = t + GRACE; s.hash = n.hash; s.rotated = t; out.rotated = n.token; await persist.devices(); }
      return out;
    },
    async rotate(deviceId) { const s = sessions.get(deviceId); if (!s) throw fault(401, 'Not signed in'); const n = newToken(s.id), t = now(); s.prevHash = s.hash; s.prevUntil = t + GRACE; s.hash = n.hash; s.rotated = t; await persist.devices(); return n.token; },
    devices: (userId, currentId) => [...sessions.values()].filter((s) => s.userId === userId).sort((a, b) => b.lastSeen - a.lastSeen).map((s) => ({ id: s.id, name: s.name, kind: s.kind, created: s.created, lastSeen: s.lastSeen, current: s.id === currentId })),
    async revoke(userId, id) { const s = sessions.get(id); if (!s || s.userId !== userId) throw fault(404, 'Unknown device'); sessions.delete(id); await persist.devices(); },
    async revokeAll(userId, exceptId) { for (const [id, s] of sessions) if (s.userId === userId && id !== exceptId) sessions.delete(id); await persist.devices(); },
    async changePassword(userId, current, next, exceptId) {
      const u = users.get(userId), limit = throttle(failKey('pw', userId), 5, 15 * 60_000, 15 * 60_000);
      if (!u || typeof current !== 'string' || !(await verifyPassword(current.slice(0, 1024), u.pass))) { limit.fail(); throw fault(403, 'Current password is wrong'); }
      checkPassword(next); u.pass = await hashPassword(next); limit.clear();
      await persist.users(); await api.revokeAll(userId, exceptId);
    },
    async createInvite(userId, ttlHours = 72) {
      if (users.get(userId)?.role !== 'owner') throw fault(403, 'Owner only');
      const code = randomBytes(12).toString('base64url'), i = { id: randomBytes(6).toString('hex'), hash: sha(code), created: now(), expires: now() + Math.min(Math.max(1, ttlHours), 24 * 30) * 3600_000, createdBy: userId, usedBy: null };
      if (invites.size >= 200) throw fault(400, 'Too many open invites');
      invites.set(i.id, i); await persist.invites(); return { id: i.id, code, expires: i.expires };
    },
    invites: () => [...invites.values()].filter((i) => i.expires > now()).map((i) => ({ id: i.id, created: i.created, expires: i.expires, used: Boolean(i.usedBy) })),
    async deleteInvite(id) { if (!invites.delete(id)) throw fault(404, 'Unknown invite'); await persist.invites(); },
    async register(username, password, inviteCode, terms = null) {
      const mode = settings.registration;
      if (mode === 'closed') throw fault(403, 'Registration is closed');
      let invite;
      if (mode === 'invite') {
        const h = typeof inviteCode === 'string' ? sha(inviteCode) : '';
        invite = [...invites.values()].find((i) => i.hash === h && !i.usedBy && i.expires > now());
        if (!invite) throw fault(403, 'Invite is invalid or expired');
      }
      const u = await api.createUser(username, password, 'user', { terms });
      if (invite) { invite.usedBy = u.id; await persist.invites(); }
      return u;
    },
    async setDisabled(ownerId, id, disabled) {
      if (users.get(ownerId)?.role !== 'owner') throw fault(403, 'Owner only');
      const u = users.get(id); if (!u) throw fault(404, 'Unknown user'); if (u.role === 'owner') throw fault(400, 'The owner cannot be disabled');
      u.disabled = Boolean(disabled); if (u.disabled) for (const [sid, s] of sessions) if (s.userId === id) sessions.delete(sid);
      await persist.users(); await persist.devices(); return publicUser(u);
    },
    /** Admin recovery (the `foxfleet user reset-password` CLI, run on the hub host while the hub is stopped): new password, every session of that user signed out. */
    async resetPassword(id, next) { const u = users.get(id); if (!u) throw fault(404, 'Unknown user'); checkPassword(next); u.pass = await hashPassword(next); await persist.users(); for (const [sid, ss] of sessions) if (ss.userId === id) sessions.delete(sid); await persist.devices(); return publicUser(u); },
    async removeUser(ownerId, id) { if (users.get(ownerId)?.role !== 'owner') throw fault(403, 'Owner only'); const u = users.get(id); if (!u) throw fault(404, 'Unknown user'); if (u.role === 'owner') throw fault(400, 'The owner cannot be removed'); users.delete(id); for (const [sid, s] of sessions) if (s.userId === id) sessions.delete(sid); await persist.users(); await persist.devices(); },
  };
  return api;
}
