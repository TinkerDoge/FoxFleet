// MEDIA: tags, as Hermes writes them for Telegram (gateway/platforms/base.py: MEDIA_TAG_CLEANUP_RE, extract_media), for FoxFleet's chat.
// TypeScript twin of server/media-tags.js (and android/.../MediaTags.kt); contract/media-tags.vectors.json pins all three.
//   parseMedia(text) -> { text: <tags and directives removed>, media: [{ ref, kind, name, voice? }] }
// `ref` is the path or URL exactly as the agent wrote it (the hub resolves it); nothing here touches the disk or the network.

export type MediaKind = 'image' | 'video' | 'audio' | 'file';
export interface MediaRef { ref: string; kind: MediaKind; name: string; voice?: boolean }
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
const MD_LOCAL_IMG = /!\[[^\]\n]*\]\(\s*((?:~\/|\/|[A-Za-z]:[\/\\])[^)\s]+)\s*\)/g;
const MD_LINK_MEDIA = /\[[^\]\n]*\]\(\s*(https?:\/\/[^)\s]+)\s*\)|(?<![(\w\/"'=])(https?:\/\/[^\s<>)"'\]]+)/g;
const MAX_TAGS = 24;

const blank = (s: string) => s.replace(/[^\n]/g, ' ');
/** Offset-preserving mask: code fences, inline code and blockquotes hold examples, never deliveries (Hermes #35695). */
function mask(text: string) {
  let m = text.replace(/(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\3[^\n]*(?=\n|$)|$)/g, (x: string) => blank(x));
  m = m.replace(/(^|\n)([ \t]*>[^\n]*)/g, (_x: string, a: string, b: string) => a + blank(b));
  m = m.replace(/(?<!MEDIA:\s{0,3})(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (x: string) => blank(x));
  return m;
}
const normalize = (raw: unknown) => {
  let p = String(raw ?? '').trim();
  if (p.length >= 2 && p[0] === p.at(-1) && '`"\''.includes(p[0])) p = p.slice(1, -1).trim();
  return p.replace(/^[`"']+/, '').replace(/[`"',.;:)}\]]+$/, '');
};
const extOf = (ref: string) => { let p = ref; if (/^https?:\/\//i.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch { p = p.split(/[?#]/)[0]; } } else p = p.split(/[?#]/)[0]; const m = /\.([A-Za-z0-9]{1,8})$/.exec(p); return m ? m[1].toLowerCase() : ''; };
export const kindOf = (ref: string): MediaKind => { const e = extOf(ref); return IMAGE_EXTS.includes(e) ? 'image' : VIDEO_EXTS.includes(e) ? 'video' : AUDIO_EXTS.includes(e) ? 'audio' : 'file'; };
export const nameOf = (ref: string) => { let p = ref; if (/^https?:\/\//i.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch { p = p.split(/[?#]/)[0]; } } const b = p.split(/[\\/]/).filter(Boolean).pop() ?? 'file'; return b.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || 'file'; };
export const isUrl = (ref: string) => /^https?:\/\//i.test(ref);

export function parseMedia(input: unknown): { text: string; media: MediaRef[] } {
  const text = typeof input === 'string' ? input : '';
  if (!text.includes('MEDIA:') && !text.includes('[[') && !text.includes('](') && !text.includes('http')) return { text, media: [] };
  const voice = text.includes('[[audio_as_voice]]'), asDoc = text.includes('[[as_document]]');
  const scan = mask(text), spans: [number, number][] = [], media: MediaRef[] = [], seen = new Set<string>();
  const add = (raw: unknown, span: [number, number] | null, { strip = true, onlyAv = false } = {}) => {
    const ref = normalize(raw); if (!ref || ref.length > 2000 || /[\x00-\x08\x0e-\x1f]/.test(ref)) return false;
    if (strip && span) spans.push(span);
    const kind = kindOf(ref); if (onlyAv && kind !== 'video' && kind !== 'audio') return false;
    if (!seen.has(ref) && media.length < MAX_TAGS) { seen.add(ref); media.push({ ref, kind: asDoc && kind === 'image' ? 'file' : kind, name: nameOf(ref), ...(voice && kind === 'audio' ? { voice: true } : {}) }); }
    return true;
  };
  const taken = (a: number, b: number) => spans.some(([x, y]) => a < y && b > x);
  for (const m of scan.matchAll(KNOWN_TAG)) add(m[1], [m.index!, m.index! + m[0].length]);
  for (const m of scan.matchAll(BARE_TAG)) { const a = m.index!, b = a + m[0].length; if (taken(a, b)) continue; const ref = normalize(m[1]); if (/^https?:\/\//i.test(ref) || ref) add(m[1], [a, b] as [number, number]); }
  for (const m of scan.matchAll(MD_LOCAL_IMG)) { const a = m.index!, b = a + m[0].length; if (!taken(a, b)) add(m[1], [a, b] as [number, number]); }
  for (const m of scan.matchAll(MD_LINK_MEDIA)) { const a = m.index!, b = a + m[0].length; if (!taken(a, b)) add(m[1] ?? m[2], null, { strip: false, onlyAv: true }); }
  let out = text;
  for (const [a, b] of spans.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  out = out.replace(/\[\[audio_as_voice\]\]|\[\[as_document\]\]/g, '');
  if (spans.length || voice || asDoc) out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, media };
}

/** While a reply is still streaming, hide a tag whose end has not arrived yet (it is never shown half-written). */
export function parseStreaming(input: unknown) {
  // A tag is held back until its line is finished (a spaced path may still grow): never a half card, never a half-written path in the text.
  const text = typeof input === 'string' ? input : '', cut = text.search(/[`"'*_]{0,3}MEDIA:[^\n]*$/i);
  const r = parseMedia(cut >= 0 ? text.slice(0, cut) : text);
  return { ...r, text: r.text.replace(/\[\[[a-z_]*\]?$/, '').trimEnd() };
}
