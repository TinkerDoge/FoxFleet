// MEDIA: tags, as Hermes writes them for Telegram (gateway/platforms/base.py: MEDIA_TAG_CLEANUP_RE, extract_media), for FoxFleet's chat.
// The same algorithm lives in web/src/lib/mediaTags.ts and android/.../MediaTags.kt; contract/media-tags.vectors.json pins all three.
//   parseMedia(text) -> { text: <tags and directives removed>, media: [{ ref, kind, name, voice? }] }
// `ref` is the path or URL exactly as the agent wrote it (the hub resolves it); nothing here touches the disk or the network.

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
export const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', '3gp', 'm4v'];
export const AUDIO_EXTS = ['mp3', 'm2a', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac'];
export const FILE_EXTS = ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'epub', 'xlsx', 'xls', 'ods', 'csv', 'tsv', 'pptx', 'ppt', 'odp', 'zip', 'tar', 'gz', 'tgz', '7z', 'kml', 'kmz', 'gpx', 'geojson'];
/** Everything a tag may deliver. (Hermes also lists svg/html/json/xml/yaml/apk: those could run in a browser or hold secrets, so they are not delivered.) */
export const DELIVERABLE = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS, ...FILE_EXTS]);
const KNOWN = [...DELIVERABLE, 'svg', 'tiff', 'html', 'htm', 'json', 'xml', 'yaml', 'yml', 'rar', 'bz2', 'xz', 'apk', 'ipa', 'key', 'log', 'py', 'sh', 'ts'].sort((a, b) => b.length - a.length).join('|');
const TERM = '[\\s`"\'*_,;:)\\]}\\[（）〈〉《》：，。；！？、\u201c\u201d\u2018\u2019【】]';
const ANCHOR = '(?:~\\/|\\/|[A-Za-z]:[\\/\\\\]|https?:\\/\\/)';
const KNOWN_TAG = new RegExp(`[\`"'*_]{0,3}MEDIA:\\s*(\`[^\`\\n]+?\`|"[^"\\n]+?"|'[^'\\n]+?'|${ANCHOR}\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${KNOWN}))(?=${TERM}|MEDIA:|\\.(?:\\s|$)|$)[\`"'*_]{0,3}\\.?`, 'gi');
const BARE_TAG = new RegExp(`[\`"'*_]{0,3}MEDIA:\\s*(\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${ANCHOR}[^\\s\`"']+?)(?=[\`"'\\s,;:)\\]}]|MEDIA:|$)[\`"'*_]{0,3}`, 'gi');
const MD_DATA_IMG = /!\[[^\]\n]*\]\(\s*(data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]{16,4000000})\s*\)/g; // Hermes' API server and some models inline pictures as data: URLs
const MD_LOCAL_IMG = /!\[[^\]\n]*\]\(\s*((?:~\/|\/|[A-Za-z]:[\/\\])[^)\s]+)\s*\)/g;
const MD_LINK_MEDIA = /\[[^\]\n]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)|(?<![(\w\/"'=])(https?:\/\/[^\s<>)"'\]]+)/g;
const MAX_TAGS = 24;

const blank = (s) => s.replace(/[^\n]/g, ' ');
/** Offset-preserving mask: code fences, inline code and blockquotes hold examples, never deliveries (Hermes #35695). */
function mask(text) {
  let m = text.replace(/(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[^\n]*(?=\n|$)|$)/g, (x) => blank(x));
  m = m.replace(/(^|\n)([ \t]*>[^\n]*)/g, (x, a, b) => a + blank(b));
  m = m.replace(/(?<!MEDIA:\s{0,3})(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (x) => blank(x));
  return m;
}
// REACT: <one emoji> on its own line is the agent's reaction to the user's message. The hub applies it; the apps never show the line.
const REACT_LINE = /^[ \t]*REACT:[ \t]*([^ \t\r\n]{1,32})[ \t]*$/gm;
const PARTIAL_REACT = /(?:^|\n)[ \t]*R(?:E(?:A(?:C(?:T(?::[^\n]*)?)?)?)?)?$/;
/** Emoji-shaped: no ASCII letters and at least one code point from U+2000 up. The hub still checks validEmoji before applying it. */
export const emojiShaped = (s) => !/[A-Za-z]/.test(s) && [...s].some((c) => c.codePointAt(0) >= 0x2000);
/** takeReact(text) -> { text: <REACT: lines removed>, react: <first one's token> | null }. Lines in code or quotes stay. */
export function takeReact(text) {
  if (!text.includes('REACT:')) return { text, react: null };
  const scan = mask(text), spans = []; let react = null;
  for (const m of scan.matchAll(REACT_LINE)) {
    if (!emojiShaped(m[1])) continue;
    react ??= m[1];
    const end = m.index + m[0].length; spans.push([m.index, text[end] === '\n' ? end + 1 : end]);
  }
  if (!spans.length) return { text, react: null };
  let out = text; for (const [a, b] of spans.reverse()) out = out.slice(0, a) + out.slice(b);
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), react };
}
const normalize = (raw) => {
  let p = String(raw ?? '').trim();
  if (p.length >= 2 && p[0] === p.at(-1) && '`"\''.includes(p[0])) p = p.slice(1, -1).trim();
  return p.replace(/^[`"']+/, '').replace(/[`"',.;:)}\]]+$/, '');
};
const extOf = (ref) => { let p = ref; if (/^https?:\/\//i.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch { p = p.split(/[?#]/)[0]; } } else p = p.split(/[?#]/)[0]; const m = /\.([A-Za-z0-9]{1,8})$/.exec(p); return m ? m[1].toLowerCase() : ''; };
export const isData = (ref) => /^data:image\//i.test(ref);
export const kindOf = (ref) => { if (isData(ref)) return 'image'; const e = extOf(ref); return IMAGE_EXTS.includes(e) ? 'image' : VIDEO_EXTS.includes(e) ? 'video' : AUDIO_EXTS.includes(e) ? 'audio' : 'file'; };
export const nameOf = (ref) => { if (isData(ref)) return 'image'; let p = ref; if (/^https?:\/\//i.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch { p = p.split(/[?#]/)[0]; } } const b = p.split(/[\\/]/).filter(Boolean).pop() ?? 'file'; return b.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || 'file'; };
export const isUrl = (ref) => /^https?:\/\//i.test(ref);

export function parseMedia(input) {
  const { text, react } = takeReact(typeof input === 'string' ? input : '');
  if (!text.includes('MEDIA:') && !text.includes('[[') && !text.includes('](') && !text.includes('http') && !text.includes('data:image')) return { text, media: [], react };
  const voice = text.includes('[[audio_as_voice]]'), asDoc = text.includes('[[as_document]]');
  const scan = mask(text), spans = [], media = [], seen = new Set();
  const add = (raw, span, { strip = true, onlyAv = false } = {}) => {
    const ref = isData(String(raw)) ? String(raw) : normalize(raw); if (!ref || (ref.length > 2000 && !isData(ref)) || /[\x00-\x08\x0e-\x1f]/.test(ref)) return false;
    if (strip && span) spans.push(span);
    const kind = kindOf(ref); if (onlyAv && kind !== 'video' && kind !== 'audio') return false;
    if (!seen.has(ref) && media.length < MAX_TAGS) { seen.add(ref); media.push({ ref, kind: asDoc && kind === 'image' ? 'file' : kind, name: nameOf(ref), ...(voice && kind === 'audio' ? { voice: true } : {}) }); }
    return true;
  };
  const taken = (a, b) => spans.some(([x, y]) => a < y && b > x);
  for (const m of scan.matchAll(KNOWN_TAG)) add(m[1], [m.index, m.index + m[0].length]);
  for (const m of scan.matchAll(BARE_TAG)) { const a = m.index, b = a + m[0].length; if (taken(a, b)) continue; const ref = normalize(m[1]); if (/^https?:\/\//i.test(ref) || ref) add(m[1], [a, b]); }
  for (const m of scan.matchAll(MD_DATA_IMG)) { const a = m.index, b = a + m[0].length; if (!taken(a, b)) add(m[1], [a, b]); }
  for (const m of scan.matchAll(MD_LOCAL_IMG)) { const a = m.index, b = a + m[0].length; if (!taken(a, b)) add(m[1], [a, b]); }
  for (const m of scan.matchAll(MD_LINK_MEDIA)) { const a = m.index, b = a + m[0].length; if (!taken(a, b)) add(m[1] ?? m[2], null, { strip: false, onlyAv: true }); }
  let out = text;
  for (const [a, b] of spans.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  out = out.replace(/\[\[audio_as_voice\]\]|\[\[as_document\]\]/g, '');
  if (spans.length || voice || asDoc) out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, media, react };
}

/** While a reply is still streaming, hide a tag whose end has not arrived yet (it is never shown half-written). */
export function parseStreaming(input) {
  // A tag is held back until its line is finished (a spaced path may still grow): never a half card, never a half-written path in the text.
  // A last line that could still become a REACT: line is held back the same way.
  const text = typeof input === 'string' ? input : '';
  const cuts = [text.search(/[`"'*_]{0,3}MEDIA:[^\n]*$/i), text.search(PARTIAL_REACT)].filter((i) => i >= 0);
  const r = parseMedia(cuts.length ? text.slice(0, Math.min(...cuts)) : text);
  return { ...r, text: r.text.replace(/\[\[[a-z_]*\]?$/, '').trimEnd() };
}

// ---------- media produced by TOOLS (image_generate, text_to_speech, send_message, screenshots, file writers) ----------
// Hermes only delivers what the model writes in its reply (MEDIA: tags, markdown images, bare paths). A tool that makes a picture or a file does not
// by itself put it in the reply, so a model that forgets the tag leaves the user with nothing. FoxFleet therefore also looks at what tools produced in
// the same turn and offers it as a card. It only reads the tool's own structured result/arguments, never free text, and never a path the tool did not
// report. Everything still goes through the same checks as a MEDIA: tag (mentioned-ref registry, connector roots/type/size, SSRF guard).
const RESULT_KEYS = new Set(['image', 'images', 'image_url', 'image_urls', 'image_path', 'video', 'videos', 'video_url', 'video_path', 'audio', 'audio_path', 'audio_url', 'media', 'media_path', 'media_url', 'media_files', 'file', 'files', 'file_path', 'filepath', 'path', 'paths', 'output', 'output_path', 'output_file', 'saved_to', 'saved_path', 'screenshot', 'screenshot_path', 'attachments', 'attachment', 'url', 'urls', 'media_tag']);
const WRITER = /^(write_?file|save_?file|create_?file|export\w*|screenshot\w*|computer_use|take_screenshot|generate_\w+|text_to_speech|tts)$/i;
const READER = /^(read_?file|view\w*|cat|open_?file|search\w*|grep|find\w*|ls|list\w*|vision\w*|analy[sz]e\w*|web_?\w*|fetch\w*|browser_(?!screenshot)\w*|session_search|memory\w*|skill\w*)$/i; // tools that LOOK at things never offer them back
const SENDER = /^(send_?message|send_?file|send_?media|share\w*)$/i;
const SAVED = /(?:saved (?:to|as)|written to|output (?:file|path)?:?|screenshot saved to|wrote)\s*[:`"']?\s*((?:~\/|\/|[A-Za-z]:[\\/])[^\s`"'<>)\]]+?\.[A-Za-z0-9]{2,5})(?=[\s`"'<>).,;\]]|$)/gi;
const MAX_TOOL_MEDIA = 12;

function collect(v, out, depth = 0, key = '') {
  if (out.length >= 64 || depth > 3 || v == null) return;
  if (typeof v === 'string') { if (v.length <= 2000) out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 16)) collect(x, out, depth + 1, key); return; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) if (RESULT_KEYS.has(k.toLowerCase())) collect(x, out, depth + 1, k); }
}
const goodRef = (r) => { const ref = normalize(r); if (!ref || ref.length > 2000 || /[\x00-\x08\x0e-\x1f\s]{1}/.test(ref.replace(/ /g, ''))) return null; if (!(isUrl(ref) || /^(?:~\/|\/|[A-Za-z]:[\\/])/.test(ref))) return null; const e = extOf(ref); return DELIVERABLE.has(e) ? ref : null; };
const failed = (res) => res && typeof res === 'object' && (res.success === false || res.ok === false || (res.error != null && res.error !== '' && res.error !== false));

/** toolMedia(name, args, result) -> [{ ref, kind, name }] (at most 12; only references the tool itself reported). */
export function toolMedia(name, args, result) {
  const n = String(name ?? ''), found = [];
  if (READER.test(n)) return [];
  let res = result; if (typeof res === 'string') { const t = res.trim(); if (t.startsWith('{') || t.startsWith('[')) { try { res = JSON.parse(t); } catch { /* plain text */ } } }
  if (failed(res)) return [];
  const strings = []; collect(res, strings);
  if (typeof res === 'string') {
    strings.push(res.length > 20000 ? res.slice(0, 20000) : res);
    for (const m of res.matchAll(SAVED)) strings.push(m[1]);
  } else if (res && typeof res === 'object') for (const s of [...strings]) for (const m of s.matchAll(SAVED)) strings.push(m[1]);
  const a = args && typeof args === 'object' ? args : {};
  if (SENDER.test(n)) for (const k of ['message', 'text', 'content', 'caption']) if (typeof a[k] === 'string') strings.push(a[k]);
  if (SENDER.test(n) || WRITER.test(n)) { const more = []; for (const k of ['media_files', 'files', 'attachments', 'path', 'file_path', 'filepath', 'output_path', 'media', 'file', 'image', 'video', 'audio']) collect({ [k]: a[k] }, more); strings.push(...more); }
  const seen = new Set();
  for (const s of strings) {
    const tags = s.includes('MEDIA:') ? parseMedia(s).media.map((m) => m.ref) : [];
    for (const r of [...tags, s]) { const ref = goodRef(r); if (ref && !seen.has(ref) && found.length < MAX_TOOL_MEDIA) { seen.add(ref); found.push({ ref, kind: kindOf(ref), name: nameOf(ref) }); } }
  }
  return found;
}
/** Text with MEDIA: lines for any of `refs` the reply does not already carry: how tool-made files reach the existing card pipeline. */
export function withMediaLines(text, refs) {
  const t = typeof text === 'string' ? text : '', have = new Set(parseMedia(t).media.map((m) => m.ref)), add = refs.filter((r) => !have.has(r) && !t.includes(r));
  return add.length ? `${t.replace(/\s+$/, '')}${t.trim() ? '\n\n' : ''}${add.map((r) => `MEDIA:${r}`).join('\n')}` : t;
}
