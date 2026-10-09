// Hub-side chat history for API-key chat agents (OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok), which have no sessions
// of their own. Stored per user next to their config, with an explicit retention setting (days; 0 = keep nothing).
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fault } from './config.js';

const MAX_SESSIONS = 300, MAX_MESSAGES = 1000, MAX_CHARS = 40_000, DAY = 86_400_000;
export const DEFAULT_RETENTION_DAYS = Number.isInteger(Number(process.env.FOXFLEET_HISTORY_DAYS)) && process.env.FOXFLEET_HISTORY_DAYS !== undefined && process.env.FOXFLEET_HISTORY_DAYS !== '' ? Math.min(Math.max(Number(process.env.FOXFLEET_HISTORY_DAYS), 0), 3650) : 90;
export const newSessionId = () => 'h_' + randomBytes(9).toString('base64url');
export const validSessionId = (s) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(String(s ?? ''));
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));

export async function historyStore(file, { now = () => Date.now() } = {}) {
  let db = { version: 1, retentionDays: DEFAULT_RETENTION_DAYS, agents: {} };
  try { const raw = JSON.parse(await readFile(file, 'utf8')); if (raw && typeof raw === 'object' && raw.agents) db = { ...db, ...raw }; } catch { /* first run */ }
  let writing = Promise.resolve();
  const save = () => (writing = writing.then(async () => { await mkdir(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; await writeFile(tmp, JSON.stringify(db), { mode: 0o600 }); await rename(tmp, file); }).catch(() => {}));
  const list = (agent) => (db.agents[agent] ??= { sessions: [] }).sessions;
  function sweep() {
    const cutoff = now() - db.retentionDays * DAY; let changed = false;
    for (const a of Object.values(db.agents)) { const keep = a.sessions.filter((s) => db.retentionDays > 0 && s.updated >= cutoff); if (keep.length !== a.sessions.length) { a.sessions = keep; changed = true; } }
    if (changed) void save();
  }
  const find = (agent, id) => { sweep(); const s = list(agent).find((x) => x.id === id); if (!s) throw fault(404, 'Session not found'); return s; };
  return {
    /** Resolves when every queued write has hit the disk (tests, shutdown). */
    flush: () => writing,
    get retentionDays() { return db.retentionDays; },
    async setRetention(days) { if (!Number.isInteger(days) || days < 0 || days > 3650) throw fault(400, 'Retention must be 0 to 3650 days'); db.retentionDays = days; sweep(); await save(); return days; },
    /** Called when a reply finishes: stores the user turn and the assistant turn under the session. */
    async append(agent, sid, userText, assistantText) {
      if (db.retentionDays === 0 || !validSessionId(sid)) return;
      const t = now(), a = list(agent); let s = a.find((x) => x.id === sid);
      if (!s) { s = { id: sid, title: clip(userText.replace(/\s+/g, ' ').trim(), 60) || 'New chat', created: t, updated: t, messages: [] }; a.unshift(s); if (a.length > MAX_SESSIONS) a.length = MAX_SESSIONS; }
      s.messages.push({ role: 'user', content: clip(userText, MAX_CHARS), ts: t }, { role: 'assistant', content: clip(assistantText, MAX_CHARS), ts: t });
      if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
      s.updated = t; a.sort((x, y) => y.updated - x.updated); sweep(); await save();
    },
    list(agent, { limit = 30, offset = 0, q = '' } = {}) {
      sweep(); const needle = q.toLowerCase(), all = list(agent).filter((s) => !needle || s.title.toLowerCase().includes(needle) || s.messages.some((m) => m.content.toLowerCase().includes(needle)));
      return { total: all.length, sessions: all.slice(offset, offset + limit).map((s) => ({ id: s.id, title: s.title, updated: s.updated, started: s.created, messages: s.messages.length, preview: clip(s.messages.at(-1)?.content.replace(/\s+/g, ' ').trim() ?? '', 140) })) };
    },
    /** Newest page first semantics: offset counts back from the end; the page itself is chronological. */
    messages(agent, id, { limit = 50, offset = 0 } = {}) {
      const s = find(agent, id), end = Math.max(s.messages.length - offset, 0), start = Math.max(end - limit, 0);
      return { messages: s.messages.slice(start, end), total: s.messages.length, offset, limit, has_more: start > 0 };
    },
    async rename(agent, id, title) { const s = find(agent, id), t = clip(String(title ?? '').replace(/[\x00-\x1f]/g, ' ').trim(), 120); if (!t) throw fault(400, 'Title required'); s.title = t; await save(); return { id, title: t }; },
    async remove(agent, id) { const s = find(agent, id); db.agents[agent].sessions = list(agent).filter((x) => x !== s); await save(); },
    async removeAgent(agent) { delete db.agents[agent]; await save(); },
  };
}
