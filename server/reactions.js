// Account-local reactions and hidden messages. The caller verifies conversation/message access and supplies the authenticated actor.
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fault } from './config.js';
import { takeReact, parseMedia } from './media-tags.js';

export const validEmoji = (value) => typeof value === 'string' && value.length <= 64 && /^\p{RGI_Emoji}$/v.test(value);
// an agent may write a bare symbol (❤, ☺) without the emoji variation selector
const asEmoji = (react) => (validEmoji(react) ? react : validEmoji(react + '\uFE0F') ? react + '\uFE0F' : null);
/** 0.4.1: what a finished reply's REACT: line does. react: the emoji it applies (or null); only: nothing else would show (no text, no media). */
export function replyReaction(text) {
  const t = typeof text === 'string' ? text : '', { react } = takeReact(t);
  if (!react) return { react: null, only: false };
  const rest = parseMedia(t);
  return { react: asEmoji(react), only: !rest.text.trim() && !rest.media.length };
}
/** Reactions agents write in their replies (a REACT: line). Each lands on the nearest earlier user message with an id. Derived on read, never stored. */
export function agentReactions(messages, actor) {
  const out = []; let user = null;
  for (const m of messages) {
    if (m?.role === 'user') { user = m.id != null ? String(m.id) : null; continue; }
    if (m?.role !== 'assistant' || !user || typeof m.content !== 'string') continue;
    const { react } = takeReact(m.content);
    if (!react) continue;
    const emoji = asEmoji(react);
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
    /**
     * Add (present) or remove one actor's emoji on a message. `message` is one id or (0.4.1) every id of the same message
     * (its upstream id and its hub id): a reaction under any of them counts, removal clears all of them, and a new one is
     * stored under the first. Resolves to true when something changed (idempotent: repeating it resolves to false).
     */
    set(agent, session, message, emoji, actor, present) {
      if (!validEmoji(emoji)) throw fault(400, 'Choose one emoji', 'invalid_emoji');
      const keys = (Array.isArray(message) ? message : [message]);
      if (!keys.length || keys.some((k) => typeof k !== 'string' || !k || k.length > 200)) throw fault(400, 'Invalid message ID', 'invalid_message_id');
      if (!actor || !['human', 'agent'].includes(actor.kind) || typeof actor.id !== 'string' || typeof actor.name !== 'string') throw fault(400, 'Invalid reaction actor');
      let changed = false;
      return mutate(next => {
        const mine = (r) => r.agent === agent && r.session === session && keys.includes(r.message) && r.emoji === emoji && r.actor.id === actor.id;
        if (!present) { for (let i = next.length - 1; i >= 0; i--) if (mine(next[i])) { next.splice(i, 1); changed = true; } return; }
        if (next.some(mine)) return;
        if (next.length >= 50000 || next.filter(r => r.agent === agent && r.session === session && keys.includes(r.message)).length >= 256) throw fault(409, 'Reaction limit reached', 'reaction_limit');
        next.push({ agent, session, message: keys[0], emoji, actor: { id: actor.id, kind: actor.kind, name: actor.name.slice(0, 100) }, at: now() }); changed = true;
      }).then(() => changed);
    },
    /** "Delete for me": hide (present) or show again one message in this account's view. Idempotent. */
    hide(agent, session, message, present) {
      // 0.4.1: like set(), one id or every id of the same message (upstream id, hub id); stored under the first
      const keys = Array.isArray(message) ? message : [message];
      if (!keys.length || keys.some((k) => typeof k !== 'string' || !k || k.length > 200)) throw fault(400, 'Invalid message ID', 'invalid_message_id');
      return mutate((_, next) => {
        const mine = (h) => h.agent === agent && h.session === session && keys.includes(h.message), i = next.findIndex(mine);
        if (!present) { for (let k = next.length - 1; k >= 0; k--) if (mine(next[k])) next.splice(k, 1); return; }
        if (i >= 0) return;
        if (next.filter(h => h.agent === agent && h.session === session).length >= hiddenPerSession) throw fault(409, 'Hidden message limit reached');
        while (next.length >= hiddenLimit) { let o = 0; for (let k = 1; k < next.length; k++) if (next[k].at < next[o].at) o = k; next.splice(o, 1); } // the global cap evicts the oldest hidden ids rather than refusing new ones
        next.push({ agent, session, message: keys[0], at: now() });
      });
    },
    hidden(agent, session) { return hidden.filter(h => h.agent === agent && h.session === session).map(h => h.message); },
    remove(agent, session) { return mutate((next, nextHidden) => { drop(next, agent, session); drop(nextHidden, agent, session); }); },
    clear() { return mutate((next, nextHidden) => { next.length = 0; nextHidden.length = 0; }); },
    flush: () => pending,
  };
}
/**
 * 0.4.1: a chat's reactions keyed by message, whichever id each was stored under (upstream id or hub id) plus the ones derived from
 * REACT: lines. resolve(id) -> { n, u, hub_id } | null (the ledger). Returns { messages: { upstream_id: groups } (ids still in the
 * transcript, as before 0.4.1), by_hub_id: { hub_id: groups } }. One actor counts once per emoji on a message.
 */
export function reactionView({ rows = {}, derived = [], resolve = () => null, transcriptIds = new Set() }) {
  const flat = [], canon = new Map();
  for (const [key, groups] of Object.entries(rows)) for (const g of groups) for (const actor of g.actors) flat.push({ message: key, emoji: g.emoji, actor });
  flat.push(...derived);
  const keyOf = (k) => {
    const r = resolve(k), c = r ? 'h:' + r.hub_id : 'u:' + k;
    if (!canon.has(c)) canon.set(c, { hub_id: r?.hub_id ?? null, u: r ? r.u ?? (transcriptIds.has(k) ? k : null) : k });
    return c;
  };
  const merged = mergeReactions({}, flat.map((x) => ({ ...x, message: keyOf(x.message) })));
  const messages = Object.create(null), byHub = Object.create(null);
  for (const [c, groups] of Object.entries(merged)) { const { hub_id, u } = canon.get(c); if (u != null && transcriptIds.has(u)) messages[u] = groups; if (hub_id) byHub[hub_id] = groups; }
  return { messages, by_hub_id: byHub };
}
