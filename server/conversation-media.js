// Room attachments (Task 6): explicit per-account, per-conversation grants.
//
// A room file is uploaded first (unattached) and becomes readable only when a room message actually
// references it. The grant lives in the room JSON (`media` rows); the bytes live beside it in
// `<account>/conversations/<fc_id>.media/<id>`. Nothing here fetches a URL, and a DM media id never
// becomes a room grant (or the other way around): callers always name the conversation.
import { mkdir, open, rename, rm, readdir, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fault } from './config.js';
import { MEDIA_MAX, MEDIA_ID, sniffBotMedia, serveFile } from './bot-media.js';
import { kindOf } from './media-tags.js';

export const ROOM_MEDIA_MAX = MEDIA_MAX;
export const ROOM_MEDIA_QUOTA = 1024 * 1024 * 1024;
export const ROOM_MEDIA_TTL = 3600_000;
export const ROOM_MEDIA_LIMIT = 10;
const HOUR = 3600_000;

const roomOf = (id) => (typeof id === 'string' && /^fc_[A-Za-z0-9_-]{16}$/.test(id) ? id : null);
const dirOf = (reg, roomId) => path.join(reg.dir, 'conversations', `${roomId}.media`);

/** The public attachment shape carried by room messages and room live events. */
export function roomMediaView(g) {
  return { id: g.id, kind: g.kind, mime: g.mime, name: g.name, size: g.size, sha256: g.sha256 };
}

/** An uploaded-but-unattached grant is usable by exactly the actor that uploaded it, for one hour. */
export function mediaGrantUsable(d, id, { actorKind, actorId, now = Date.now() } = {}) {
  const g = Array.isArray(d?.media) ? d.media.find((x) => x.id === id) : null;
  if (!g || g.revoked_at || g.message_id || g.actor_kind !== actorKind || g.actor_id !== actorId) return null;
  if (!Number.isSafeInteger(g.expires_at) || g.expires_at <= now) return null;
  return g;
}

/**
 * Bind unattached uploads to a message inside the same room mutation that appends it. Any failure throws and
 * rolls the whole message back, so a grant can never be exposed by a message that was not committed.
 */
export function attachGrantedMedia(d, ids, actor, message, now = Date.now()) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > ROOM_MEDIA_LIMIT) throw fault(400, 'Invalid attachment list', 'invalid_media');
  if (new Set(ids).size !== ids.length) throw fault(400, 'Duplicate attachment id', 'invalid_media');
  const out = [];
  for (const id of ids) {
    if (!MEDIA_ID.test(id)) throw fault(404, 'Attachment not found', 'media_not_found');
    const g = mediaGrantUsable(d, id, { actorKind: actor.kind, actorId: actor.id, now });
    if (!g) throw fault(404, 'Attachment not found', 'media_not_found');
    g.message_id = message.id; g.attached_at = now;
    out.push(roomMediaView(g));
  }
  return out;
}

/** Mark every attachment of one message revoked (delete/revoke). Bytes are removed by the caller afterwards. */
export function revokeMessageMedia(d, messageId, at = Date.now()) {
  const revoked = [];
  for (const g of d.media ?? []) {
    if (g.message_id !== messageId || g.revoked_at) continue;
    g.revoked_at = at;
    revoked.push(g.id);
  }
  return revoked;
}

/**
 * Blob store for room attachments. Grant rows are owned by conversation-store; this module only classifies,
 * writes, serves and removes bytes after the caller has made the grant decision.
 */
export function conversationMedia({ maxBytes = ROOM_MEDIA_MAX, quotaBytes = ROOM_MEDIA_QUOTA, now = Date.now } = {}) {
  for (const v of [maxBytes, quotaBytes]) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError('Invalid conversation media limit');

  async function sweep(reg, roomId, grants = []) {
    const dir = dirOf(reg, roomId);
    const known = new Set(grants.filter((g) => g && !g.revoked_at
      && (g.message_id || (Number.isSafeInteger(g.expires_at) && g.expires_at > now()))).map((g) => g.id));
    for (const name of await readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })) {
      if (!known.has(name) && (await stat(path.join(dir, name))).mtimeMs + HOUR <= now()) await rm(path.join(dir, name), { force: true });
    }
  }

  async function upload({ reg, roomId, actor, body, length, name = 'file', guard }) {
    const room = roomOf(roomId);
    if (!room) throw fault(404, 'Conversation not found', 'conversation_not_found');
    if (!actor || !['human', 'agent'].includes(actor.kind) || typeof actor.id !== 'string') throw fault(400, 'Invalid actor');
    guard?.();
    const dir = dirOf(reg, room), inventory = await readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    let used = 0;
    for (const entry of inventory) used += (await stat(path.join(dir, entry))).size;
    if (quotaBytes - used <= 0 || (Number.isFinite(length) && length > maxBytes) || (Number.isFinite(length) && length > quotaBytes - used)) throw fault(413, 'Room media limit exceeded', 'too_large');
    const id = 'fbm_' + randomBytes(18).toString('base64url'), dest = path.join(dir, id), temp = dest + '.tmp';
    let fd, size = 0, head = Buffer.alloc(0), committed = false;
    const hash = createHash('sha256');
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 }); fd = await open(temp, 'wx', 0o600);
      for await (const chunk of body) {
        guard?.(); size += chunk.length;
        if (size > maxBytes || size > quotaBytes - used) throw fault(413, 'Room media limit exceeded', 'too_large');
        if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
        hash.update(chunk); await fd.writeFile(chunk);
      }
      if (size < 1) throw fault(400, 'Empty attachment', 'invalid_media');
      const { ext, mime } = sniffBotMedia(head);
      const stem = path.basename(String(name).replaceAll('\\', '/')).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'file';
      const at = now();
      const row = {
        id, name: `${stem}.${ext}`, mime, kind: kindOf(`file.${ext}`), size, sha256: hash.digest('hex'),
        created: at, expires_at: at + ROOM_MEDIA_TTL, source: 'room',
        actor_kind: actor.kind, actor_id: actor.id, message_id: null, attached_at: null, revoked_at: null,
      };
      await fd.sync(); await fd.close(); fd = null; guard?.();
      await rename(temp, dest); committed = true;
      return row;
    } finally {
      await fd?.close().catch(() => {});
      await rm(temp, { force: true });
      if (!committed) await rm(dest, { force: true });
    }
  }

  async function serve({ reg, roomId, grant, req, res }) {
    const room = roomOf(roomId);
    if (!room || !grant || !MEDIA_ID.test(grant.id)) throw fault(404, 'Not found');
    await serveFile({ file: path.join(dirOf(reg, room), grant.id), name: grant.name, mime: grant.mime, req, res });
  }

  const remove = async (reg, roomId, id) => {
    const room = roomOf(roomId);
    if (!room || !MEDIA_ID.test(id)) return;
    await rm(path.join(dirOf(reg, room), id), { force: true });
  };
  const removeRoom = (reg, roomId) => {
    const room = roomOf(roomId);
    return room ? rm(dirOf(reg, room), { recursive: true, force: true }) : Promise.resolve();
  };
  return { upload, serve, remove, removeRoom, sweep };
}
