// User-side room routes (contract/openapi.json `/api/conversations…`). This file only parses and shapes HTTP;
// all state and access decisions live in conversation-store.js. Routing/dispatch, stop and resume are Tasks 3-5.
import { fault, ROOM_LIMITS } from './config.js';
import { MEDIA_ID } from './bot-media.js';

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Durable-only Stop when no bot transport is mounted: cancellation can be requested from nowhere. */
async function durableStop(store, id, owner) {
  const result = await store.stop(id, { ownerId: owner.id });
  const agents = {}, dispatches = [];
  for (const row of result.active) {
    agents[row.target_agent_id] = 'uncertain';
    dispatches.push({ dispatch_id: row.id, target_agent_id: row.target_agent_id, status: 'uncertain' });
  }
  for (const row of result.cancelled) {
    if (!(row.target_agent_id in agents)) agents[row.target_agent_id] = 'stopped';
    dispatches.push({ dispatch_id: row.id, target_agent_id: row.target_agent_id, status: 'stopped', kind: row.kind });
  }
  const confirmed = result.active.length === 0;
  return {
    stopped: confirmed, confirmed, state: confirmed ? (dispatches.length ? 'stopped' : 'idle') : 'running',
    epoch: result.epoch, paused: true, agents, dispatches,
    cancelled_queued: result.cancelled.filter((row) => row.kind === 'queued').length,
    cancelled_approvals: result.cancelled.filter((row) => row.kind === 'approval').length,
    cancelled_cards: result.cards_closed,
  };
}

function queryInt(value, name) {
  if (value === null || value === undefined || value === '') return undefined;
  if (!/^\d{1,15}$/.test(value)) throw fault(400, `Invalid ${name}`);
  return Number(value);
}

/**
 * Handle any `/api/conversations…` request for one authenticated account. Returns the response (the caller
 * passes `sendJson`) or throws a hub fault; unknown children are a plain 404. Owner Stop/Resume go through
 * the account's dispatch engine when the bot API is on; the durable store remains the fallback control plane.
 */
export async function conversationsHttp({ req, res, url, parts, auth, store, agentOf, sendJson, readJson, roomControl, reg, media }) {
  const owner = { id: auth.user.id, name: auth.user.username };
  const device = auth.device ?? '';
  const id = parts[2];
  const action = parts[3];
  const method = req.method;

  const memberOf = (value) => {
    const name = typeof value === 'string' && value.startsWith('agent:') ? value.slice(6) : value;
    if (typeof name !== 'string' || !AGENT_ID.test(name)) throw fault(404, 'Unknown agent for this account', 'agent_not_in_account');
    return agentOf(name);
  };

  if (parts.length === 2) {
    if (method === 'GET') {
      const limit = queryInt(url.searchParams.get('limit'), 'limit') ?? 30;
      const offset = queryInt(url.searchParams.get('offset'), 'offset') ?? 0;
      return sendJson(res, 200, await store.list({ device, limit, offset }));
    }
    if (method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const title = body.title;
      const ids = body.member_ids === undefined ? [] : body.member_ids;
      if (!Array.isArray(ids)) throw fault(400, 'member_ids must be an array');
      if (ids.length > ROOM_LIMITS.max_room_members) throw fault(409, 'Too many members', 'too_many_members');
      const agents = ids.map(memberOf).filter((agent, i, list) => list.findIndex((x) => x.actor_id === agent.actor_id) === i);
      const conversation = await store.create({ owner, title, agents, client_id: body.client_id, device });
      return sendJson(res, 201, conversation);
    }
    throw fault(404, 'Not found');
  }

  if (parts.length === 3) {
    if (method === 'GET') return sendJson(res, 200, await store.get(id, { device }));
    if (method === 'PATCH') {
      const body = await readJson(req, 64 * 1024);
      return sendJson(res, 200, await store.rename(id, { ownerId: owner.id, title: body.title, device }));
    }
    throw fault(404, 'Not found');
  }

  if (parts.length === 5 && action === 'members') {
    if (method === 'PUT') {
      const agent = memberOf(parts[4]);
      return sendJson(res, 200, await store.addMember(id, { ownerId: owner.id, agent, device }));
    }
    if (method === 'DELETE') return sendJson(res, 200, await store.removeMember(id, { ownerId: owner.id, agentId: parts[4], device }));
    throw fault(404, 'Not found');
  }

  if (parts.length === 4 && action === 'messages') {
    if (method === 'GET') {
      const limit = queryInt(url.searchParams.get('limit'), 'limit');
      const offset = queryInt(url.searchParams.get('offset'), 'offset');
      const before = queryInt(url.searchParams.get('before') ?? url.searchParams.get('cursor'), 'cursor');
      return sendJson(res, 200, await store.messages(id, {
        device, ...(limit === undefined ? {} : { limit }), ...(offset === undefined ? {} : { offset }), ...(before === undefined ? {} : { before }),
      }));
    }
    if (method === 'POST') {
      const body = await readJson(req, ROOM_LIMITS.max_text_bytes * 2 + 16 * 1024);
      const result = await store.send(id, {
        actor: { kind: 'human', id: owner.id, name: owner.name }, text: body.text,
        format: body.format ?? 'text', mentions: body.mentions, reply_to: body.reply_to, client_id: body.client_id,
        media: body.media,
      });
      return sendJson(res, 202, { message: result.message, conversation_id: result.message.conversation_id, dispatched_to: [] });
    }
    throw fault(404, 'Not found');
  }

  if (parts.length === 5 && action === 'messages') {
    if (method === 'GET') return sendJson(res, 200, await store.message(id, parts[4], { device }));
    throw fault(404, 'Not found');
  }

  if (parts.length === 4 && action === 'read' && method === 'POST') {
    const body = await readJson(req, 4096);
    if (body.up_to !== undefined && (!Number.isSafeInteger(body.up_to) || body.up_to < 0)) throw fault(400, 'up_to must be a non-negative whole number', 'invalid_read_position');
    return sendJson(res, 200, await store.read(id, { device, up_to: body.up_to }));
  }

  if (parts.length === 4 && action === 'preferences' && method === 'PUT') {
    const body = await readJson(req, 4096);
    const preferences = await store.setPreferences(id, { device, preferences: body });
    // Room notifications are room-wide: the latest mute setting applies to every client, not just this device.
    if (typeof body?.muted === 'boolean' && reg?.notify) await reg.notify.setRoomMute({ conversationId: id, muted: body.muted });
    return sendJson(res, 200, preferences);
  }

  if (parts.length === 4 && action === 'stop' && method === 'POST') {
    const human = { kind: 'human', ...owner };
    const result = roomControl?.stop ? await roomControl.stop(id, human) : await durableStop(store, id, human);
    return sendJson(res, 200, result);
  }

  if (parts.length === 4 && action === 'resume' && method === 'POST') {
    const human = { kind: 'human', ...owner };
    if (roomControl?.resume) await roomControl.resume(id, human);
    else await store.resume(id, { ownerId: owner.id });
    return sendJson(res, 200, await store.get(id, { device }));
  }

  // Room attachments: the owner uploads bytes over HTTP, references the returned id from a room message,
  // and downloads them only while the grant is attached to a live message. Bot members use /api/bot/media.
  if (parts.length === 4 && action === 'media' && method === 'POST') {
    if (!media || !reg) throw fault(404, 'Not found');
    const snap = await store.snapshot(id);
    await media.sweep(reg, id, snap.media ?? []);
    const row = await media.upload({
      reg, roomId: id, actor: { kind: 'human', id: owner.id },
      body: req, length: Number(req.headers['content-length']),
      name: req.headers['x-foxfleet-name'],
      guard: () => { if (snap.owner_id !== owner.id) throw fault(404, 'Conversation not found', 'conversation_not_found'); },
    });
    try { await store.grantMedia(id, row); }
    catch (e) { await media.remove(reg, id, row.id); throw e; }
    return sendJson(res, 201, { ...row, media_id: row.id, expires_at: row.expires_at });
  }

  if (parts.length === 5 && action === 'media' && ['GET', 'HEAD', 'DELETE'].includes(method)) {
    const mediaId = parts[4];
    if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) throw fault(404, 'Not found');
    if (method === 'DELETE') {
      if (!media || !reg) throw fault(404, 'Not found');
      const grant = await store.revokeMedia(id, { ownerId: owner.id, mediaId });
      await media.remove(reg, id, grant.id);
      return sendJson(res, 200, { ok: true, deleted: true, id: grant.id });
    }
    if (!media || !reg) throw fault(404, 'Not found');
    const readable = await store.readableMedia(id, mediaId);
    if (!readable) throw fault(404, 'Not found');
    return media.serve({ reg, roomId: id, grant: readable.grant, req, res });
  }

  throw fault(404, 'Not found');
}
