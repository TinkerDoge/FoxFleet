// Turns Hermes session rows (hermes_state messages: role, content string|array|null, tool_calls, tool_call_id, tool_name,
// reasoning/reasoning_content, timestamp in seconds, display_kind) into the clean shape both apps render:
//   { role: 'user'|'assistant', content, reasoning?, tools?: [{ name, args?, result?, ok? }], images?: [url], ts?, id? }
// Tool-call and tool-result rows fold into the assistant turn they belong to, consecutive assistant steps merge into one
// message, hidden/system rows and control tags disappear.
const CONTROL = [/<system-reminder>[\s\S]*?<\/system-reminder>/gi, /<memory-context>[\s\S]*?<\/memory-context>/gi, /<tool_call>[\s\S]*?<\/tool_call>/gi, /<tool_response>[\s\S]*?<\/tool_response>/gi, /<\/?(?:tool_calls?|function_calls?)>/gi];
const THINK = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const ms = (t) => { const n = Number(t); return Number.isFinite(n) && n > 0 ? Math.round(n < 1e12 ? n * 1000 : n) : undefined; };

/** Text, images and a "[file]" note from string or multimodal-array content. */
export function flattenContent(c) {
  if (typeof c === 'string') return { text: c, images: [] };
  if (!Array.isArray(c)) return { text: '', images: [] };
  const text = [], images = [];
  for (const p of c) {
    if (typeof p === 'string') text.push(p);
    else if (p && typeof p === 'object') {
      if (typeof p.text === 'string') text.push(p.text);
      else if (p.type === 'image_url' || p.type === 'input_image' || p.type === 'image') { const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url ?? p.url ?? p.source?.url; if (typeof u === 'string' && /^(https:|data:image\/)/.test(u) && u.length < 400_000) images.push(u); else text.push('[image]'); }
      else if (p.type === 'file' || p.type === 'input_file') text.push(`📎 ${p.filename ?? p.file?.filename ?? 'file'}`);
    }
  }
  return { text: text.join(''), images };
}
export function cleanText(s) {
  let reasoning = '', out = s.replace(THINK, (_, __, body) => { reasoning += (reasoning ? '\n\n' : '') + body.trim(); return ''; });
  for (const re of CONTROL) out = out.replace(re, '');
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), reasoning };
}
const argSummary = (a) => { if (a == null) return undefined; let o = a; if (typeof a === 'string') { try { o = JSON.parse(a); } catch { return clip(a.replace(/\s+/g, ' '), 160); } } if (o && typeof o === 'object') { const first = Object.entries(o).find(([, v]) => typeof v === 'string' || typeof v === 'number'); return first ? clip(`${first[0]}: ${String(first[1]).replace(/\s+/g, ' ')}`, 160) : undefined; } return clip(String(o), 160); };
const resultSummary = (c) => { const { text } = flattenContent(c); const t = text.trim(); if (!t) return { result: '', ok: true }; let ok = true; try { const j = JSON.parse(t); if (j && typeof j === 'object' && (j.error || j.success === false || j.ok === false)) ok = false; } catch { /* plain text */ } return { result: clip(t.replace(/\s+/g, ' '), 300), ok }; };

export function normalizeTranscript(rows) {
  const out = []; const pending = new Map(); // tool_call_id -> tool entry
  for (const m of rows) {
    if (!m || typeof m !== 'object' || m.display_kind === 'hidden') continue;
    const role = m.role;
    if (role === 'system') continue;
    if (role === 'tool' || role === 'function') {
      const { result, ok } = resultSummary(m.content), entry = pending.get(m.tool_call_id);
      if (entry) { entry.result = result; entry.ok = ok; pending.delete(m.tool_call_id); }
      else { let last = out[out.length - 1]; if (!last || last.role !== 'assistant') { last = { role: 'assistant', content: '' }; out.push(last); } (last.tools ??= []).push({ name: String(m.tool_name ?? 'tool'), result, ok }); }
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const { text, images } = flattenContent(m.content), cleaned = cleanText(text);
    const reasoning = [typeof m.reasoning_content === 'string' ? m.reasoning_content : typeof m.reasoning === 'string' ? m.reasoning : '', cleaned.reasoning].filter(Boolean).join('\n\n').trim();
    const tools = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc) => { const e = { name: String(tc?.function?.name ?? tc?.name ?? 'tool'), ...(argSummary(tc?.function?.arguments ?? tc?.arguments) ? { args: argSummary(tc?.function?.arguments ?? tc?.arguments) } : {}) }; if (tc?.id) pending.set(tc.id, e); return e; });
    const base = { role, content: cleaned.text, ...(reasoning ? { reasoning } : {}), ...(tools.length ? { tools } : {}), ...(images.length ? { images } : {}), ...(ms(m.timestamp) ? { ts: ms(m.timestamp) } : {}), ...(m.id != null ? { id: String(m.id) } : {}) };
    const prev = out[out.length - 1];
    if (role === 'assistant' && prev?.role === 'assistant') { // one assistant turn made of several steps
      prev.content = [prev.content, base.content].filter(Boolean).join('\n\n'); if (base.reasoning) prev.reasoning = [prev.reasoning, base.reasoning].filter(Boolean).join('\n\n');
      if (base.tools) prev.tools = [...(prev.tools ?? []), ...base.tools]; if (base.ts) prev.ts = base.ts; continue;
    }
    if (!base.content && !base.images && !base.tools && !base.reasoning) continue;
    out.push(base);
  }
  return out.filter((m) => m.content || m.images || m.tools || m.reasoning);
}
/** A Hermes session row from the dashboard list, in the one shape the apps use. */
export function sessionRow(s) {
  const t = s.last_active ?? s.updated_at ?? s.started_at ?? s.created_at;
  return { id: String(s.id), title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : null, updated: ms(t) ?? null, started: ms(s.started_at ?? s.created_at) ?? null, messages: Number.isInteger(s.message_count) ? s.message_count : null,
    preview: clip(String(s.preview ?? s.last_message ?? s.summary ?? '').replace(/\s+/g, ' ').trim(), 140), ...(s.pinned ? { pinned: true } : {}) };
}
