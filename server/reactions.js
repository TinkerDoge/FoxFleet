// Account-local reactions and hidden messages. The caller verifies conversation/message access and supplies the authenticated actor.
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fault } from './config.js';
import { takeReact } from './media-tags.js';

export const validEmoji = (value) => typeof value === 'string' && value.length <= 64 && /^\p{RGI_Emoji}$/v.test(value);
/** Reactions agents write in their replies (a REACT: line). Each lands on the nearest earlier user message with an id. Derived on read, never stored. */
export function agentReactions(messages, actor) {
  const out = []; let user = null;
  for (const m of messages) {
    if (m?.role === 'user') { user = m.id != null ? String(m.id) : null; continue; }
    if (m?.role !== 'assistant' || !user || typeof m.content !== 'string') continue;
    const { react } = takeReact(m.content);
    if (!react) continue;
    // an agent may write a bare symbol (❤, ☺) without the emoji variation selector
    const emoji = validEmoji(react) ? react : validEmoji(react + '\uFE0F') ? react + '\uFE0F' : null;
    if (emoji) out.push({ message: user, emoji, actor });
  }
  return out;
}
/** Stored reactions plus derived ones; an actor counts once per emoji on a message. */
export function mergeReactions(stored, derived) {
  const merged = Object.create(null); // no prototype: a message id like "__proto__" is just a key
  for (const [id, groups] of Object.entries(stored)) merged[id] = groups.map((g) => ({ emoji: g.emoji, actors: [...g.actors] }));
  for (const d of derived) {
    const groups = (merged[d.message] ??= []); let g = groups.find((x) => x.emoji === d.emoji);
    if (!g) { g = { emoji: d.emoji, actors: [] }; groups.push(g); }
    if (!g.actors.some((a) => a.id === d.actor.id)) g.actors.push(d.actor);
  }
  return merged;
}
export async function reactionStore(file, { now = () => Date.now(), retentionMs = 90 * 86400000, hiddenLimit = 50000, hiddenPerSession = 5000 } = {}) {
  let rows = [], hidden = []; // hidden: [{ agent, session, message, at }], this account's "delete for me" list; it never expires on its own
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(data.rows)) throw new Error('Invalid reaction store');
    rows = data.rows; hidden = Array.isArray(data.hidden) ? data.hidden.filter(h => h && typeof h === 'object' && typeof h.agent === 'string' && typeof h.session === 'string' && typeof h.message === 'string') : [];
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let pending = Promise.resolve();
  function mutate(change) {
    const work = pending.then(async () => {
      const next = rows.filter(r => r.at > now() - retentionMs).map(r => ({ ...r })), nextHidden = hidden.map(h => ({ ...h })); change(next, nextHidden);
      const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
      await mkdir(path.dirname(file), { recursive: true });
      try { await writeFile(tmp, JSON.stringify({ version: 2, rows: next, hidden: nextHidden }), { mode: 0o600, flag: 'wx' }); await rename(tmp, file); rows = next; hidden = nextHidden; }
      finally { await unlink(tmp).catch(() => {}); }
    });
    pending = work.catch(() => {}); return work;
  }
  const drop = (list, agent, session) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].agent === agent && (session === undefined || list[i].session === session)) list.splice(i, 1); };
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
    /** "Delete for me": hide (present) or show again one message in this account's view. Idempotent. */
    hide(agent, session, message, present) {
      if (typeof message !== 'string' || !message || message.length > 200) throw fault(400, 'Invalid message ID');
      return mutate((_, next) => {
        const i = next.findIndex(h => h.agent === agent && h.session === session && h.message === message);
        if (!present) { if (i >= 0) next.splice(i, 1); return; }
        if (i >= 0) return;
        if (next.filter(h => h.agent === agent && h.session === session).length >= hiddenPerSession) throw fault(409, 'Hidden message limit reached');
        while (next.length >= hiddenLimit) { let o = 0; for (let k = 1; k < next.length; k++) if (next[k].at < next[o].at) o = k; next.splice(o, 1); } // the global cap evicts the oldest hidden ids rather than refusing new ones
        next.push({ agent, session, message, at: now() });
      });
    },
    hidden(agent, session) { return hidden.filter(h => h.agent === agent && h.session === session).map(h => h.message); },
    remove(agent, session) { return mutate((next, nextHidden) => { drop(next, agent, session); drop(nextHidden, agent, session); }); },
    clear() { return mutate((next, nextHidden) => { next.length = 0; nextHidden.length = 0; }); },
    flush: () => pending,
  };
}
