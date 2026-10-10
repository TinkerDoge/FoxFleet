// Per-user agent activity: what the agent list shows under each name (last message, when, which chat) and the user's pinned agents.
// Stored next to the user's other files (activity.json). Previews are short plain text: no Markdown, no MEDIA: tags, nothing secret-looking.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fault, redact } from './config.js';
import { parseMedia } from './media-tags.js';

export const PREVIEW_MAX = 140, MAX_PINS = 50;

/** One short line of plain text from a reply or a message. */
export function previewOf(input, max = PREVIEW_MAX) {
  const parsed = parseMedia(typeof input === 'string' ? input : ''); let t = parsed.text;
  t = t.replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/`([^`\n]*)`/g, '$1').replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, a) => (a ? `[${a}]` : '[image]'))
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1').replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
    .replace(/<[^>]{1,200}>/g, ' ').replace(/\bhttps?:\/\/\S+/g, (u) => { try { return new URL(u).hostname; } catch { return 'link'; } });
  t = redact(t).replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[address]').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t && parsed.media.length) { const m = parsed.media[0]; t = m.kind === 'image' ? 'Photo' : m.kind === 'video' ? 'Video' : m.kind === 'audio' ? (m.voice ? 'Voice message' : 'Audio') : `File: ${m.name}`; if (parsed.media.length > 1) t += ` +${parsed.media.length - 1}`; }
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

export async function activityStore(file, { now = () => Date.now() } = {}) {
  let db = { version: 1, agents: {}, pins: [] };
  try { const raw = JSON.parse(await readFile(file, 'utf8')); if (raw && typeof raw === 'object') db = { ...db, ...raw, agents: raw.agents ?? {}, pins: Array.isArray(raw.pins) ? raw.pins : [] }; } catch { /* first run */ }
  let writing = Promise.resolve(), timer = null;
  const write = () => (writing = writing.then(async () => { await mkdir(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; await writeFile(tmp, JSON.stringify(db), { mode: 0o600 }); await rename(tmp, file); }).catch(() => {}));
  const later = () => { if (!timer) { timer = setTimeout(() => { timer = null; void write(); }, 400); timer.unref?.(); } };
  return {
    flush: async () => { if (timer) { clearTimeout(timer); timer = null; await write(); } return writing; },
    /** A message went out (role 'user') or a reply finished (role 'assistant'). Cheap: one object update, a debounced write. */
    touch(agent, { role, text, session, title, at }) {
      if (typeof agent !== 'string' || !agent || (role !== 'user' && role !== 'assistant')) return;
      const p = previewOf(text), prev = db.agents[agent] ?? {};
      if (!p && !title) return;
      db.agents[agent] = { at: Number.isFinite(at) ? at : now(), role, preview: p || prev.preview || '', title: title ? previewOf(title, 80) : prev.title ?? '', session: session ?? prev.session ?? null };
      later();
    },
    /** Seed (only when nothing is known yet) from older history, so chats from before this feature show up. */
    seed(agent, { at, role = 'assistant', text, title, session }) { if (db.agents[agent] || !Number.isFinite(at)) return; const p = previewOf(text); if (!p && !title) return; db.agents[agent] = { at, role, preview: p, title: title ? previewOf(title, 80) : '', session: session ?? null }; later(); },
    get: (agent) => db.agents[agent] ?? null,
    pins: () => [...db.pins],
    async pin(agent, on, known = () => true) {
      if (!known(agent)) throw fault(404, 'Unknown agent');
      const had = db.pins.includes(agent);
      if (on && !had) { if (db.pins.length >= MAX_PINS) throw fault(400, `At most ${MAX_PINS} pinned agents`); db.pins.push(agent); } // pin order = the order you pinned them
      if (!on && had) db.pins = db.pins.filter((x) => x !== agent);
      await write(); return [...db.pins];
    },
    async forget(agent) { delete db.agents[agent]; db.pins = db.pins.filter((x) => x !== agent); await write(); },
  };
}

/** The one ordering rule (web and Android implement the same): pinned first in pin order, then newest activity, then quiet agents in registry order. */
export function sortAgents(list) {
  return [...list].sort((a, b) => {
    const pa = a.pin_order ?? -1, pb = b.pin_order ?? -1;
    if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
    if (pa >= 0 && pb >= 0) return pa - pb;
    const ta = a.last_activity_at ?? 0, tb = b.last_activity_at ?? 0;
    if (ta !== tb) return tb - ta;
    return (a.order ?? 0) - (b.order ?? 0);
  });
}
