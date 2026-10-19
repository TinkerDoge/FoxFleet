// Bot media bytes live beside the JSON store. No URL fetching and no byte cache.
import { mkdir, open, rename, rm, readdir, stat } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fault } from './config.js';
import { DELIVERABLE, kindOf } from './media-tags.js';

export const MEDIA_ID = /^fbm_[A-Za-z0-9_-]{24}$/;
export const MEDIA_MAX = 25 * 1024 * 1024;
export const MEDIA_QUOTA = 1024 * 1024 * 1024;
const HOUR = 3600_000;
export const mediaRef = (m) => `/bot-media/${m.id}/${m.name}`;
export const mediaText = (text, media = []) => [text, ...media.map((m) => `MEDIA:${mediaRef(m)}`)].filter(Boolean).join('\n');

// Classify bytes, never the supplied suffix or MIME. Ambiguous containers use their generic class.
export function sniffBotMedia(b) {
  const at = (n, s) => b.subarray(n, n + s.length).toString('latin1') === s;
  const hex = (s) => b.subarray(0, s.length / 2).toString('hex') === s;
  let type;
  if (hex('89504e470d0a1a0a')) type = ['png', 'image/png'];
  else if (hex('ffd8ff')) type = ['jpg', 'image/jpeg'];
  else if (at(0, 'GIF87a') || at(0, 'GIF89a')) type = ['gif', 'image/gif'];
  else if (at(0, 'RIFF') && at(8, 'WEBP')) type = ['webp', 'image/webp'];
  else if (at(0, 'BM') && b.length >= 26) type = ['bmp', 'image/bmp'];
  else if (hex('1a45dfa3') && b.includes(Buffer.from('webm'))) type = ['webm', 'video/webm'];
  else if (hex('1a45dfa3') && b.includes(Buffer.from('matroska'))) type = ['mkv', 'video/x-matroska'];
  else if (at(0, 'RIFF') && at(8, 'WAVE')) type = ['wav', 'audio/wav'];
  else if (at(0, 'RIFF') && at(8, 'AVI ')) type = ['avi', 'video/x-msvideo'];
  else if (at(0, '%PDF-')) type = ['pdf', 'application/pdf'];
  else if (at(0, 'OggS')) type = ['ogg', 'audio/ogg'];
  else if (at(0, 'fLaC')) type = ['flac', 'audio/flac'];
  else if (at(0, 'ID3')) type = ['mp3', 'audio/mpeg'];
  else if (hex('504b0304') || hex('504b0506')) type = ['zip', 'application/zip'];
  else if (hex('1f8b08')) type = ['gz', 'application/gzip'];
  else if (hex('377abcaf271c')) type = ['7z', 'application/x-7z-compressed'];
  else if (at(257, 'ustar')) type = ['tar', 'application/x-tar'];
  else if (at(4, 'ftyp')) {
    const brand = b.subarray(8, 12).toString('ascii');
    type = ['avif', 'avis'].includes(brand) ? ['avif', 'image/avif'] : ['M4A ', 'M4B '].includes(brand) ? ['m4a', 'audio/mp4'] : ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'qt  ', '3gp4', '3gp5', '3gp6'].includes(brand) ? ['mp4', 'video/mp4'] : null;
  }
  if (!type || !DELIVERABLE.has(type[0])) throw fault(415, 'This file type is not delivered');
  return { ext: type[0], mime: type[1] };
}

/** Serve one stored blob with the bot-media response contract (octet-stream, sniffed MIME header, Range, no-store). */
export async function serveFile({ file, name, mime, req, res }) {
  const fd = await open(file, 'r').catch(() => { throw fault(404, 'Not found'); });
  try {
    const size = (await fd.stat()).size;
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Foxfleet-Mime': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename="${name}"` };
    let start = 0, end = size - 1, status = 200;
    if (req.headers.range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!r || !(r[1] || r[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
      end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    await new Promise((resolve, reject) => {
      const stream = fd.createReadStream({ start, end, autoClose: false });
      stream.on('error', reject); res.on('close', () => { stream.destroy(); resolve(); }); stream.on('end', resolve); stream.pipe(res);
    });
  } finally { await fd.close(); }
}

export function botMedia({ maxBytes = MEDIA_MAX, quotaBytes = MEDIA_QUOTA } = {}) {
  for (const v of [maxBytes, quotaBytes]) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError('Invalid bot media limit');
  const queues = new Map();
  const dirOf = (reg, botId) => path.join(reg.dir, 'bot', `${botId}.media`);
  function serial(botId, fn) {
    const work = (queues.get(botId) ?? Promise.resolve()).then(fn);
    const tail = work.catch(() => {}); queues.set(botId, tail);
    tail.finally(() => { if (queues.get(botId) === tail) queues.delete(botId); });
    return work;
  }
  async function sweep(reg, botId, store) {
    const dir = dirOf(reg, botId), rows = store.mediaRows();
    for (const m of rows) if (!m.attached && m.created + HOUR <= Date.now() && await store.expireMedia(m.id)) await rm(path.join(dir, m.id), { force: true });
    // Recover blobs orphaned by a crash between rename and metadata commit.
    const known = new Set(store.mediaRows().map((m) => m.id));
    for (const name of await readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!known.has(name) && (await stat(path.join(dir, name))).mtimeMs + HOUR <= Date.now()) await rm(path.join(dir, name), { force: true });
    }
  }
  async function upload({ reg, botId, store, body, length, name = 'file', chatId, guard, source = 'bot' }) {
    return serial(botId, async () => {
      guard?.();
      if (!store.hasChat(chatId)) throw fault(404, 'Unknown chat');
      await sweep(reg, botId, store);
      const inventory = await readdir(dirOf(reg, botId)).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
      let used = 0;
      for (const name of inventory) used += (await stat(path.join(dirOf(reg, botId), name))).size;
      const remaining = quotaBytes - used;
      if (remaining <= 0 || length > maxBytes || length > remaining) throw fault(413, 'Bot media limit exceeded', 'too_large');
      const id = 'fbm_' + randomBytes(18).toString('base64url'), dir = dirOf(reg, botId), dest = path.join(dir, id), temp = dest + '.tmp';
      let fd, size = 0, head = Buffer.alloc(0), committed = false;
      const hash = createHash('sha256');
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 }); fd = await open(temp, 'wx', 0o600);
        for await (const chunk of body) {
          guard?.(); size += chunk.length;
          if (size > maxBytes || size > remaining) throw fault(413, 'Bot media limit exceeded', 'too_large');
          if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
          hash.update(chunk); await fd.writeFile(chunk);
        }
        const { ext, mime } = sniffBotMedia(head);
        const stem = path.basename(String(name).replaceAll('\\', '/')).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'file';
        const row = { id, chat_id: chatId, name: `${stem}.${ext}`, mime, kind: kindOf(`file.${ext}`), size, sha256: hash.digest('hex'), created: Date.now(), attached: false, source };
        await fd.sync(); await fd.close(); fd = null; guard?.();
        if (!store.hasChat(chatId)) throw fault(404, 'Unknown chat');
        await rename(temp, dest);
        await store.addMedia(row, guard); committed = true;
        return row;
      } finally {
        await fd?.close().catch(() => {});
        await rm(temp, { force: true });
        if (!committed) await rm(dest, { force: true });
      }
    });
  }
  async function serve({ reg, botId, store, id, req, res }) {
    const m = MEDIA_ID.test(id) && store.mediaRows().find((m) => m.id === id && (m.attached || m.created + HOUR > Date.now()));
    if (!m) throw fault(404, 'Not found');
    await serveFile({ file: path.join(dirOf(reg, botId), id), name: m.name, mime: m.mime, req, res });
  }
  return { upload, serve, sweep: (reg, botId, store) => serial(botId, () => sweep(reg, botId, store)),
    fromBytes: (args, bytes) => upload({ ...args, body: Readable.from([bytes]), length: bytes.length }),
    discard: (reg, botId, store, id) => serial(botId, async () => { await rm(path.join(dirOf(reg, botId), id), { force: true }); await store.dropMedia(id); }),
    removeChat: (reg, botId, store, chatId) => serial(botId, async () => {
      for (const m of store.mediaRows().filter((m) => m.chat_id === chatId)) { await rm(path.join(dirOf(reg, botId), m.id), { force: true }); await store.dropMedia(m.id); }
    }),
    remove: (reg, botId) => serial(botId, () => rm(dirOf(reg, botId), { recursive: true, force: true })),
    idle: () => Promise.all([...queues.values()]) };
}
