// Account-local reactions. The caller verifies conversation/message access and supplies the authenticated actor.
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fault } from './config.js';

export const validEmoji = (value) => typeof value === 'string' && value.length <= 64 && /^\p{RGI_Emoji}$/v.test(value);
export async function reactionStore(file, { now = () => Date.now(), retentionMs = 90 * 86400000 } = {}) {
  let rows = [];
  try { const data = JSON.parse(await readFile(file, 'utf8')); if (!Array.isArray(data.rows)) throw new Error('Invalid reaction store'); rows = data.rows; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let pending = Promise.resolve();
  function mutate(change) {
    const work = pending.then(async () => {
      const next = rows.filter(r => r.at > now() - retentionMs).map(r => ({ ...r })); change(next);
      const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
      await mkdir(path.dirname(file), { recursive: true });
      try { await writeFile(tmp, JSON.stringify({ version: 1, rows: next }), { mode: 0o600, flag: 'wx' }); await rename(tmp, file); rows = next; }
      finally { await unlink(tmp).catch(() => {}); }
    });
    pending = work.catch(() => {}); return work;
  }
  return {
    list(agent, session) {
      const messages = new Map();
      for (const r of rows) {
        if (r.agent !== agent || r.session !== session || r.at <= now() - retentionMs) continue;
        if (!messages.has(r.message)) messages.set(r.message, new Map());
        const groups = messages.get(r.message);
        if (!groups.has(r.emoji)) groups.set(r.emoji, []);
        groups.get(r.emoji).push(r.actor);
      }
      return Object.fromEntries([...messages].map(([id, groups]) => [id, [...groups].map(([emoji, actors]) => ({ emoji, actors }))]));
    },
    set(agent, session, message, emoji, actor, present) {
      if (!validEmoji(emoji)) throw fault(400, 'Choose one emoji');
      if (typeof message !== 'string' || !message || message.length > 200) throw fault(400, 'Invalid message ID');
      if (!actor || !['human', 'agent'].includes(actor.kind) || typeof actor.id !== 'string' || typeof actor.name !== 'string') throw fault(400, 'Invalid reaction actor');
      return mutate(next => {
        const i = next.findIndex(r => r.agent === agent && r.session === session && r.message === message && r.emoji === emoji && r.actor.id === actor.id);
        if (!present) { if (i >= 0) next.splice(i, 1); return; }
        if (i >= 0) return;
        if (next.length >= 50000 || next.filter(r => r.agent === agent && r.session === session && r.message === message).length >= 256) throw fault(409, 'Reaction limit reached');
        next.push({ agent, session, message, emoji, actor: { id: actor.id, kind: actor.kind, name: actor.name.slice(0, 100) }, at: now() });
      });
    },
    remove(agent, session) { return mutate(next => { for (let i = next.length - 1; i >= 0; i--) if (next[i].agent === agent && (session === undefined || next[i].session === session)) next.splice(i, 1); }); },
    retain(agent, sessions) { const keep = new Set(sessions); return mutate(next => { for (let i = next.length - 1; i >= 0; i--) if (next[i].agent === agent && !keep.has(next[i].session)) next.splice(i, 1); }); },
    clear() { return mutate(next => { next.length = 0; }); },
    flush: () => pending,
  };
}
