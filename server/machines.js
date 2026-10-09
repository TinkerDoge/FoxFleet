// Machines: one connector process per computer. A machine is paired once with a short-lived, single-use pairing code
// (created by a signed-in user, bound to that user), exchanged for a machine token. The hub keeps only a hash of the token.
// Profiles found on the machine become agents (kind hermes, connection 'machine') in the owning user's registry.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fault } from './config.js';

export const CODE_TTL_MS = 15 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const normalizeCode = (c) => String(c ?? '').toUpperCase().replace(/[\s-]/g, '');
export const validCode = (c) => /^[A-Z2-9]{10}$/.test(c) && ![...c].some((ch) => !ALPHABET.includes(ch));
export const formatCode = (c) => `${c.slice(0, 5)}-${c.slice(5)}`;
const newCode = () => { let out = ''; for (const b of randomBytes(10)) out += ALPHABET[b % ALPHABET.length]; return out; };
const cleanName = (n, fallback) => { const s = String(n ?? '').replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 48); return s || fallback; };
const cleanOs = (o) => (['linux', 'darwin', 'win32'].includes(o) ? o : 'other');
const cleanProfile = (p) => String(p ?? '');

export async function machineStore(file, { now = () => Date.now() } = {}) {
  let machines = [];
  try { const raw = JSON.parse(await readFile(file, 'utf8')); if (Array.isArray(raw.machines)) machines = raw.machines; } catch { /* first run */ }
  const pairings = new Map(); // code hash -> { userId, expires, machineId?, used, result? }
  const fails = { byIp: new Map(), global: [] };
  async function save() { await mkdir(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; await writeFile(tmp, JSON.stringify({ version: 1, machines }, null, 1), { mode: 0o600 }); await rename(tmp, file); }
  const sweep = () => { const t = now(); for (const [k, p] of pairings) if (p.expires + 3600_000 < t) pairings.delete(k); };
  function failure(ip) {
    const t = now(), win = 15 * 60_000;
    const rec = fails.byIp.get(ip) ?? { n: 0, until: 0, since: t }; if (t - rec.since > win) { rec.n = 0; rec.since = t; }
    rec.n++; if (rec.n >= 8) rec.until = t + win; fails.byIp.set(ip, rec);
    fails.global = fails.global.filter((x) => t - x < win); fails.global.push(t);
  }
  function lockedFor(ip) {
    const t = now(), rec = fails.byIp.get(ip);
    if (rec && rec.until > t) return Math.ceil((rec.until - t) / 1000);
    fails.global = fails.global.filter((x) => t - x < 15 * 60_000);
    if (fails.global.length >= 60) return 60; // someone is guessing codes against the whole hub
    return 0;
  }
  const publicMachine = (m, extra = {}) => ({ id: m.id, name: m.name, os: m.os ?? 'other', created: m.created, lastSeen: m.lastSeen ?? null, paired: Boolean(m.tokenHash), profiles: m.profiles ?? [], ...extra });
  return {
    publicMachine,
    all: (userId) => machines.filter((m) => m.userId === userId),
    get(id) { return machines.find((m) => m.id === id); },
    owned(userId, id) { const m = machines.find((x) => x.id === id && x.userId === userId); if (!m) throw fault(404, 'Machine not found'); return m; },
    createPairing(userId, { machineId } = {}) {
      sweep();
      if ([...pairings.values()].filter((p) => p.userId === userId && !p.used && p.expires > now()).length >= 5) throw fault(429, 'Too many open pairing codes; use or wait for one to expire');
      if (machineId) this.owned(userId, machineId);
      const code = newCode(); pairings.set(sha(code), { userId, expires: now() + CODE_TTL_MS, machineId: machineId ?? null, used: false, result: null });
      return { code, display: formatCode(code), expires: now() + CODE_TTL_MS };
    },
    pairingStatus(userId, codeInput) {
      const p = pairings.get(sha(normalizeCode(codeInput)));
      if (!p || p.userId !== userId) throw fault(404, 'Unknown pairing code');
      if (p.result) { const m = machines.find((x) => x.id === p.result); return { state: 'paired', machine: m ? publicMachine(m) : null }; }
      return { state: p.expires <= now() ? 'expired' : 'waiting', expires: p.expires };
    },
    // Exchange a code for a machine token. Unauthenticated; the caller throttles and passes the client address.
    async redeem(codeInput, { name, os } = {}, ip = '?') {
      const wait = lockedFor(ip); if (wait) { const e = fault(429, 'Too many wrong codes; try again later'); e.retryAfter = wait; throw e; }
      const code = normalizeCode(codeInput), key = sha(code), p = validCode(code) ? pairings.get(key) : null;
      if (!p || p.used || p.expires <= now()) { failure(ip); throw fault(403, 'That pairing code is wrong, already used or expired'); }
      p.used = true; // single use, even if the rest fails
      const secret = randomBytes(32).toString('base64url');
      let m = p.machineId ? machines.find((x) => x.id === p.machineId && x.userId === p.userId) : null;
      if (p.machineId && !m) throw fault(403, 'That machine no longer exists');
      if (!m) {
        if (machines.filter((x) => x.userId === p.userId).length >= 20) throw fault(400, 'Machine limit reached');
        m = { id: randomBytes(16).toString('hex'), userId: p.userId, name: cleanName(name, 'My machine'), created: now(), profiles: [] };
        const taken = new Set(machines.filter((x) => x.userId === p.userId).map((x) => x.name)); let n = 2, base = m.name; while (taken.has(m.name)) m.name = `${base} ${n++}`;
        machines.push(m);
      }
      m.tokenHash = sha(secret); m.os = cleanOs(os); p.result = m.id; await save();
      return { machineId: m.id, token: `${m.id}.${secret}`, name: m.name, userId: m.userId };
    },
    authenticate(token) {
      const [id, secret] = String(token).split('.'); if (!/^[0-9a-f]{32}$/.test(id ?? '') || !secret) return null;
      const m = machines.find((x) => x.id === id); if (!m?.tokenHash) return null;
      const a = Buffer.from(sha(secret)), b = Buffer.from(m.tokenHash); return a.length === b.length && timingSafeEqual(a, b) ? m : null;
    },
    async touch(id, patch = {}) { const m = machines.find((x) => x.id === id); if (!m) return; Object.assign(m, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), { lastSeen: now() }); await save(); },
    async rename(userId, id, name) { const m = this.owned(userId, id); const n = cleanName(name, ''); if (!n) throw fault(400, 'Name required'); if (machines.some((x) => x.userId === userId && x.id !== id && x.name === n)) throw fault(409, 'You already have a machine with that name'); m.name = n; await save(); return m; },
    // Rotate: the old token stops working at once; a fresh code re-pairs the SAME machine (its agents stay).
    async invalidateToken(userId, id) { const m = this.owned(userId, id); m.tokenHash = null; await save(); return m; },
    async remove(userId, id) { const m = this.owned(userId, id); machines = machines.filter((x) => x !== m); await save(); return m; },
    setProfiles(id, list) { const m = machines.find((x) => x.id === id); if (m) m.profiles = list.map((p) => ({ profile: cleanProfile(p.profile), agent: String(p.agent ?? '') })); return save(); },
    failure, lockedFor,
  };
}
