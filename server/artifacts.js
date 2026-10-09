import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fault } from './config.js';
import { validMessages } from './hermes.js';

const sensitive = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.git', 'mcp-tokens', 'pairing', 'auth.json', 'auth.lock', 'credentials', 'config.yaml', 'config.json', '.anthropic_oauth.json', 'google_token.json', 'google_oauth_pending.json', 'google_oauth.json', 'webhook_subscriptions.json', 'bws_cache.json', 'bws_cache.enc.json', '.git-credentials', 'id_rsa', 'id_ed25519', 'passwd', 'shadow']);
const types = {
  '.png': ['image/png', 'image'], '.jpg': ['image/jpeg', 'image'], '.jpeg': ['image/jpeg', 'image'], '.gif': ['image/gif', 'image'], '.webp': ['image/webp', 'image'], '.svg': ['image/svg+xml', 'image'],
  '.mp4': ['video/mp4', 'video'], '.webm': ['video/webm', 'video'], '.mov': ['video/quicktime', 'video'], '.mp3': ['audio/mpeg', 'audio'], '.wav': ['audio/wav', 'audio'], '.ogg': ['audio/ogg', 'audio'], '.flac': ['audio/flac', 'audio'], '.m4a': ['audio/mp4', 'audio'],
  '.pdf': ['application/pdf', 'pdf'], '.txt': ['text/plain', 'doc'], '.md': ['text/markdown', 'doc'], '.csv': ['text/csv', 'table'], '.tsv': ['text/tab-separated-values', 'table'], '.json': ['application/json', 'code'], '.html': ['text/plain', 'code'], '.htm': ['text/plain', 'code'], '.xml': ['text/plain', 'code'],
};
export function artifactType(file) {
  const ext = path.posix.extname(file.replaceAll('\\', '/')).toLowerCase();
  return types[ext] ?? (/^\.(?:[cm]?js|jsx|tsx?|py|rs|go|c|h|cpp|hpp|java|kt|sh|css|scss|sql|ya?ml|toml|ini|log)$/.test(ext) ? ['text/plain', 'code'] : ['application/octet-stream', 'binary']);
}
export function safeArtifactPath(file) {
  if (typeof file !== 'string' || file.length < 2 || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file) || file !== file.trim()) return false;
  const normalized = file.replaceAll('\\', '/');
  // Hermes resolves a relative output against this session's saved cwd.
  if (normalized.startsWith('//') || normalized.startsWith('~') || normalized.endsWith('/')) return false;
  if (/^\/(?:proc|sys|dev)(?:\/|$)/i.test(normalized) || /[:%]/.test(normalized.slice(/^[A-Za-z]:/.test(normalized) ? 2 : 0))) return false;
  return !normalized.split('/').some((part) => part === '..' || part === '.' || sensitive.has(part.toLowerCase()) || /^\.env(?:\.|$|rc$)/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part));
}
function strings(value, out = [], depth = 0) {
  if (depth > 8) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) if (['text', 'content', 'path', 'file_path', 'output', 'result', 'url'].includes(key)) strings(item, out, depth + 1);
  return out;
}
function mentioned(file, transcript) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('(^|[\\s\\x60"\'(<\\[{=:])' + escaped + '(?=$|[\\s\\x60"\')>\\]},;!?]|\\.(?=\\s|$))');
  return transcript.some((text) => match.test(text));
}
export function artifactRegistry() {
  const registry = new Map(), origins = new WeakMap();
  // Public metadata never carries credentials; its private origin is the exact
  // saved connection revision whose transcript authorized the path.
  const same = (a, m) => origins.get(a) === m;
  return {
    register(m, session, files, data) {
      if (!Array.isArray(files) || files.length < 1 || files.length > 32 || files.some((file) => !safeArtifactPath(file))) throw fault(400, 'Invalid or sensitive artifact path');
      const transcript = validMessages(data).filter((row) => ['assistant', 'tool', 'function'].includes(row.role)).flatMap((row) => strings(row.content));
      if (files.some((file) => !mentioned(file, transcript))) throw fault(400, 'Artifact path not found in originating session');
      return [...new Set(files)].map((file) => {
        const existing = [...registry.values()].find((a) => same(a, m) && a.session_id === session && a.path === file); if (existing) return existing;
        const [mime, kind] = artifactType(file), a = { id: randomUUID(), name: file.replaceAll('\\', '/').split('/').at(-1), path: file, agent: m.name, profile: m.profile, session_id: session, mime, kind };
        origins.set(a, m);
        if (registry.size >= 500) registry.delete(registry.keys().next().value); registry.set(a.id, a); return a;
      });
    },
    list: (m, session) => [...registry.values()].filter((a) => same(a, m) && (!session || a.session_id === session)),
    get(m, id) { const a = registry.get(id); if (!a || !same(a, m)) throw fault(404, 'Unknown artifact'); return a; },
    clearAgent(name) { for (const [id, a] of registry) if (a.agent === name) registry.delete(id); },
    clear() { registry.clear(); },
  };
}
