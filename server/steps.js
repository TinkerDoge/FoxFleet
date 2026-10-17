// Live step detail shared by the run stream adapters (hermes-runs.js, hermes-ui.js / native-facade.js), the run registry and the
// live v2 log: short, clipped and REDACTED previews (config.js redact() runs on the full text first, then the result is clipped, so a
// cut can never leave part of a secret the patterns would have caught) of tool arguments and results, status levels, and the reasoning/tools summary a finished
// reply carries on message.new. See docs/LIVE-EVENTS.md ("Step detail").
import { redact } from './config.js';

const REASONING_MAX_BYTES = 64 * 1024;
const clipText = (t) => (Buffer.byteLength(t) <= REASONING_MAX_BYTES ? { text: t, truncated: false } : { text: Buffer.from(t).subarray(0, REASONING_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, ''), truncated: true });

export const TOOL_NAME_MAX = 80, TOOL_PREVIEW_MAX = 200, TOOL_RESULT_MAX = 500, STEP_TEXT_MAX = 300;
export const MSG_TOOLS_MAX = 50, MSG_TOOL_FIELD_MAX = 500;

/** Cut to n characters (code points) and mark the cut with "…", the way history clips tool args and results. */
export const clip = (s, n) => { const a = [...String(s ?? '')]; return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const asText = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(asText).join('\n') : v && typeof v === 'object' ? asText(v.text ?? v.content ?? '') : '');

/** One-line preview of tool arguments (object, JSON string or plain text), at most TOOL_PREVIEW_MAX characters. Empty when none. */
export function argsPreview(args) {
  if (args == null || args === '') return '';
  let o = args;
  if (typeof args === 'string') { try { o = JSON.parse(args); } catch { return guardCut(clip(flat(redact(args)), TOOL_PREVIEW_MAX)); } }
  // objects: redact() masks values under secret-looking keys (password, token, api_key …) and secret-looking text in every value
  if (o && typeof o === 'object') { let s; try { s = JSON.stringify(redact(o)); } catch { s = ''; } return s && s !== '{}' && s !== '[]' ? guardCut(clip(flat(redact(s)), TOOL_PREVIEW_MAX)) : ''; }
  return guardCut(clip(flat(redact(String(o))), TOOL_PREVIEW_MAX));
}
/**
 * A cut must not leave the start of a secret the patterns would have caught whole (`sk-pro…`, `--password=hun…`): pad the cut end with
 * letters, redact again, and if the tail is masked keep the masked form. Text that came already clipped from elsewhere (history) gets
 * the same check.
 */
const PAD = 'Z'.repeat(24);
export function guardCut(text, mark = '…') {
  if (mark && !text.endsWith(mark)) return text;
  const body = mark ? text.slice(0, -mark.length) : text, r = redact(body + PAD);
  return r.endsWith(PAD) ? text : r.replace(/Z+$/, '') + mark;
}
/** Redacted on the full text, then clipped, then cut-checked: every preview and step text goes through here. */
export const safeClip = (v, n) => guardCut(clip(redact(String(v ?? '')), n));
/** Result preview (at most TOOL_RESULT_MAX characters) and whether the tool succeeded: an explicit error flag wins, else a JSON result with error / success:false / ok:false / a non-zero exit code is a failure. */
export function toolOutcome(result, { error } = {}) {
  let text = typeof result === 'string' ? result : result != null && typeof result === 'object' ? (() => { try { return JSON.stringify(redact(result)); } catch { return ''; } })() : result == null ? '' : String(result);
  let ok = true, j = null;
  if (result && typeof result === 'object') j = result; else { try { j = JSON.parse(text); } catch { /* plain text */ } }
  if (j && typeof j === 'object' && !Array.isArray(j) && (j.error || j.success === false || j.ok === false || (Number.isFinite(j.exit_code) && j.exit_code !== 0))) ok = false;
  if (error === true || (typeof error === 'string' && error)) { ok = false; if (!text.trim() && typeof error === 'string') text = error; }
  return { ok, result_preview: guardCut(clip(redact(text).trim(), TOOL_RESULT_MAX)) };
}
/** Status level for foxfleet.step: info | warn | error. */
export const levelOf = (v) => { const s = String(v ?? '').toLowerCase(); return /err|fail|fatal/.test(s) ? 'error' : /warn|timeout|timed.?out|cancel|interrupt|retry/.test(s) ? 'warn' : 'info'; };
export const stepText = (v) => guardCut(clip(flat(redact(asText(v))), STEP_TEXT_MAX));
/** Milliseconds from Hermes' seconds (duration / duration_s) or milliseconds (duration_ms); undefined when absent. */
export function durationMs(d) {
  if (Number.isFinite(d?.duration_ms) && d.duration_ms >= 0) return Math.round(d.duration_ms);
  const s = Number.isFinite(d?.duration_s) ? d.duration_s : Number.isFinite(d?.duration) ? d.duration : undefined;
  return s !== undefined && s >= 0 ? Math.round(s * 1000) : undefined;
}

/** The reasoning / tools fields a message carries (message.new / message.edited), clipped like history: reasoning 64 KiB UTF-8 (+ reasoning_truncated), at most 50 tools of { name, args?, result?, ok? } with args/result at most 500 characters. */
export function messageExtras({ reasoning, tools } = {}) {
  const out = {};
  if (typeof reasoning === 'string' && reasoning.trim()) { const r = clipText(redact(reasoning).trim()); out.reasoning = r.truncated ? guardCut(r.text, '') : r.text; if (r.truncated) out.reasoning_truncated = true; }
  if (Array.isArray(tools) && tools.length) {
    const list = tools.filter((t) => t && typeof t === 'object').slice(0, MSG_TOOLS_MAX).map((t) => ({ name: safeClip(t.name || 'tool', TOOL_NAME_MAX),
      ...(t.args ? { args: safeClip(t.args, MSG_TOOL_FIELD_MAX) } : {}), ...(t.result ? { result: safeClip(t.result, MSG_TOOL_FIELD_MAX) } : {}), ...(typeof t.ok === 'boolean' ? { ok: t.ok } : {}) }));
    if (list.length) out.tools = list;
  }
  return out;
}
