import { Marked } from 'marked';
import DOMPurify from 'dompurify';

const md = new Marked({ gfm: true, breaks: false });
const ALLOWED_LINK = /^(https?:|mailto:|#)/i;
// Images may come from https, an inline data URL of an image, or the hub's own media routes (same origin, absolute path).
const ALLOWED_IMG = /^(https:\/\/|data:image\/(png|jpe?g|gif|webp);base64,|\/api\/)/i;

let hooked = false;
function hook() {
  if (hooked) return; hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (!ALLOWED_LINK.test(href.trim())) node.removeAttribute('href');
      else if (!href.startsWith('#')) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); }
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      if (!ALLOWED_IMG.test(src.trim())) node.remove?.(); else { node.setAttribute('loading', 'lazy'); node.setAttribute('referrerpolicy', 'no-referrer'); node.setAttribute('data-viewable', ''); }
    }
  });
}

/** Markdown to sanitized HTML. Raw HTML in the source is stripped, scripts/handlers/styles never survive. */
export function renderMarkdown(src: string): string {
  hook();
  const html = md.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span', 'sup', 'sub'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'align', 'type', 'checked', 'disabled', 'start'],
    ALLOW_DATA_ATTR: false, FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'svg', 'math'], FORBID_ATTR: ['style', 'srcset'],
  });
}

/** After inserting rendered HTML: wrap code blocks with a language label and a copy button, wrap tables for horizontal scroll. */
export function enhance(root: HTMLElement) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('code')) return;
    const wrap = document.createElement('div'); wrap.className = 'code';
    const lang = /language-([\w+-]+)/.exec(pre.querySelector('code')?.className ?? '')?.[1];
    const bar = document.createElement('div'); bar.className = 'code-bar';
    const label = document.createElement('span'); label.textContent = lang ?? 'code';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'copy'; btn.textContent = 'Copy'; btn.setAttribute('data-copy', '');
    bar.append(label, btn); pre.replaceWith(wrap); wrap.append(bar, pre);
  });
  root.querySelectorAll('table').forEach((t) => { if (t.parentElement?.className !== 'table-wrap') { const w = document.createElement('div'); w.className = 'table-wrap'; t.replaceWith(w); w.append(t); } });
}

const VIDEO = /\.(mp4|webm|mov)(\?|$)/i;
export const isVideoUrl = (u: string) => VIDEO.test(u);
