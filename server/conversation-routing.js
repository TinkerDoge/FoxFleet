// Deterministic room routing (Task 3). Pure functions only: no storage, no clocks, no display names.
//
// A human room message is addressed by exactly one of:
//   1. typed mention entities (kind=agent, id=agent:<id>) that name active members, deduplicated;
//   2. otherwise, a reply to a committed agent-authored room message: that message's author;
//   3. otherwise nobody: the message is stored and is a no-op.
// Message text is never scanned. Agent-authored messages never route: a structured handoff (see
// conversation-dispatch.js) is the only agent -> agent path. Members are matched by actor id only, so a
// renamed agent routes exactly as before.

const AGENT_ID = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONE = Object.freeze({ rule: 'none', recipients: Object.freeze([]) });
const none = () => ({ rule: 'none', recipients: [] });

/** Active agent member ids from rows (`{actor_kind, actor_id, removed_at}`) or bare `agent:` ids. */
function activeAgentIds(members) {
  const ids = new Set();
  if (!Array.isArray(members)) return ids;
  for (const row of members) {
    if (typeof row === 'string') {
      if (AGENT_ID.test(row)) ids.add(row);
      continue;
    }
    if (!row || row.actor_kind !== 'agent' || typeof row.actor_id !== 'string' || !AGENT_ID.test(row.actor_id)) continue;
    if (row.removed_at !== null && row.removed_at !== undefined) continue;
    ids.add(row.actor_id);
  }
  return ids;
}

/**
 * Route one stored room message. `messages` are the room's committed messages (for the reply lookup) and
 * `members` are its membership rows. Returns `{ rule: 'mention' | 'reply' | 'none', recipients: [agentId] }`
 * with recipients sorted and unique (stable agent-id order).
 */
export function routeRoomMessage({ message, messages = [], members = [] } = {}) {
  if (!message || typeof message !== 'object') return none();
  // Only a human message is a request. Agents, hub status notices and deleted rows never route.
  if (message.author_kind !== 'human' || message.deleted_at) return none();
  const active = activeAgentIds(members);

  const mentioned = new Set();
  for (const entity of Array.isArray(message.mentions) ? message.mentions : []) {
    if (!entity || entity.kind !== 'agent' || typeof entity.id !== 'string') continue;
    if (!AGENT_ID.test(entity.id) || !active.has(entity.id)) continue;
    mentioned.add(entity.id);
  }
  if (mentioned.size) return { rule: 'mention', recipients: [...mentioned].sort() };

  const replyTo = message.reply_to;
  if (typeof replyTo === 'string') {
    const target = (Array.isArray(messages) ? messages : []).find((m) => m && m.id === replyTo);
    if (target && !target.deleted_at && !target.system && target.author_kind === 'agent'
      && typeof target.author_id === 'string' && active.has(target.author_id)) {
      return { rule: 'reply', recipients: [target.author_id] };
    }
  }
  return none();
}

export { NONE as NO_RECIPIENTS };
