// Mailbox for agents that cannot be called (Scribe): the owner's messages queue here, the agent
// pulls them over the hub's MCP endpoint (hub_get_messages) and answers with hub_post_message.
// Threads are exposed to the apps through the normal sessions/messages routes.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';

export const TEXT_LIMIT = 32 * 1024, THREADS_MAX = 50, MESSAGES_MAX = 300;
const id = (prefix) => `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
export const threadId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);

// OpenAI content (string or parts) -> plain text an outside agent can read.
export function plainText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => p?.type === 'text' ? String(p.text ?? '') : p?.type === 'image_url' ? '[image]' : '').filter(Boolean).join('\n');
}

export async function inboxStore(file) {
  let data = { agents: {} };
  try { const raw = JSON.parse(await readFile(file, 'utf8')); if (raw && typeof raw.agents === 'object') data = raw; } catch {}
  let pending = Promise.resolve(), dirty = false;
  function save() {
    if (dirty) return pending; dirty = true;
    pending = pending.then(async () => {
      dirty = false; await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await rename(temp, file);
    }).catch(() => {});
    return pending;
  }
  const agent = (name) => (data.agents[name] ??= { threads: {}, lastSeen: 0 });
  function thread(name, tid, title) {
    const a = agent(name);
    if (tid && a.threads[tid]) return a.threads[tid];
    const t = { id: tid && threadId(tid) ? tid : id('inbox'), title: (title || 'Conversation').slice(0, 80), created: Date.now(), updated: Date.now(), messages: [] };
    a.threads[t.id] = t;
    const ids = Object.keys(a.threads);
    if (ids.length > THREADS_MAX) { ids.sort((x, y) => a.threads[x].updated - a.threads[y].updated); for (const old of ids.slice(0, ids.length - THREADS_MAX)) delete a.threads[old]; }
    return t;
  }
  function push(t, msg) { t.messages.push(msg); if (t.messages.length > MESSAGES_MAX) t.messages.splice(0, t.messages.length - MESSAGES_MAX); t.updated = msg.at; }
  return {
    // Owner (app/web) -> agent.
    fromOwner(name, tid, content) {
      const text = plainText(content).trim();
      if (!text) throw fault(400, 'Message is empty');
      if (text.length > TEXT_LIMIT) throw fault(413, 'Message too long for the inbox');
      const t = thread(name, tid, text.split('\n')[0]);
      const msg = { id: id('m'), role: 'user', content: text, at: Date.now(), delivered: false };
      push(t, msg); save(); return { thread: t.id, message: msg };
    },
    // Agent pulls undelivered owner messages (oldest first) and they become delivered.
    take(name, limit = 20) {
      const a = agent(name); a.lastSeen = Date.now();
      const out = [];
      for (const t of Object.values(a.threads)) for (const m of t.messages) if (m.role === 'user' && !m.delivered) out.push({ thread_id: t.id, thread_title: t.title, message_id: m.id, text: m.content, sent_at: new Date(m.at).toISOString(), m });
      out.sort((x, y) => x.m.at - y.m.at);
      const batch = out.slice(0, Math.max(1, Math.min(50, limit)));
      for (const row of batch) row.m.delivered = true;
      save(); return { messages: batch.map(({ m, ...row }) => row), remaining: out.length - batch.length };
    },
    // Agent -> owner. Without a thread, answers the thread with the most recent owner message.
    fromAgent(name, tid, text) {
      if (typeof text !== 'string' || !text.trim()) throw fault(400, 'text is required');
      if (text.length > 64 * 1024) throw fault(413, 'text is too long (64 KB max)');
      const a = agent(name); a.lastSeen = Date.now();
      let t = tid ? a.threads[tid] : undefined;
      if (tid && !t) throw fault(404, 'Unknown thread_id');
      if (!t) t = Object.values(a.threads).sort((x, y) => y.updated - x.updated)[0] || thread(name, null, 'From the agent');
      const msg = { id: id('m'), role: 'assistant', content: text, at: Date.now() };
      push(t, msg); save(); return { thread_id: t.id, message_id: msg.id };
    },
    sessions(name) {
      return Object.values(agent(name).threads).sort((x, y) => y.updated - x.updated).map((t) => ({ id: t.id, title: t.title, started_at: t.created / 1000, last_active: t.updated / 1000, message_count: t.messages.length, source: 'inbox' }));
    },
    messages(name, tid) {
      const t = agent(name).threads[tid]; if (!t) throw fault(404, 'Unknown session');
      return { messages: t.messages.map((m) => ({ role: m.role, content: m.content, timestamp: m.at / 1000, ...(m.role === 'user' ? { delivered: m.delivered } : {}) })) };
    },
    lastSeen: (name) => agent(name).lastSeen || 0,
    drop(name) { if (data.agents[name]) { delete data.agents[name]; save(); } },
    flush: () => pending,
  };
}
