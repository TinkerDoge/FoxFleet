// Room routing: typed mention entities -> reply-to-agent fallback -> unaddressed no-op.
// Routing is pure and deterministic; it never reads display names and never scans message text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRoomMessage } from '../conversation-routing.js';

const member = (id, name = id, extra = {}) => ({ actor_kind: 'agent', actor_id: id, name, role: 'member', removed_at: null, generation: 1, ...extra });
const humanMessage = (over = {}) => ({ id: 'fm_human', author_kind: 'human', author_id: 'u_owner', body: 'hello', mentions: [], reply_to: null, deleted_at: null, ...over });
const agentMessage = (id, author, over = {}) => ({ id, author_kind: 'agent', author_id: author, body: 'reply', mentions: [], reply_to: null, deleted_at: null, ...over });
const mention = (id, offset = 0, length = 4) => ({ kind: 'agent', id, offset, length });

test('a valid typed mention selects its agent; duplicate entities collapse to one recipient', () => {
  const members = [member('agent:sora'), member('agent:sumi')];
  const routed = routeRoomMessage({
    message: humanMessage({ body: '@Sora @SUMI @Sora', mentions: [mention('agent:sumi', 0, 5), mention('agent:sora', 6, 5), mention('agent:sora', 12, 5)] }),
    messages: [], members,
  });
  assert.deepEqual(routed, { rule: 'mention', recipients: ['agent:sora', 'agent:sumi'] });
});

test('text that merely looks like a mention never routes: quoted or code @name is not an entity', () => {
  const members = [member('agent:sora')];
  for (const body of ['@Sora please look', '`@Sora`', '> @Sora quoted', 'Sora', '@sora']) {
    const routed = routeRoomMessage({ message: humanMessage({ body }), messages: [], members });
    assert.deepEqual(routed, { rule: 'none', recipients: [] }, body);
  }
});

test('mentions take precedence over a reply target', () => {
  const members = [member('agent:sumi'), member('agent:sora')];
  const reply = agentMessage('fm_sumo', 'agent:sumi');
  const routed = routeRoomMessage({
    message: humanMessage({ mentions: [mention('agent:sora')], reply_to: reply.id }), messages: [reply], members,
  });
  assert.deepEqual(routed, { rule: 'mention', recipients: ['agent:sora'] });
});

test('without mentions, a reply to an agent-authored room message selects that agent', () => {
  const members = [member('agent:sumi'), member('agent:sora')];
  const reply = agentMessage('fm_sumo', 'agent:sumi');
  assert.deepEqual(routeRoomMessage({ message: humanMessage({ reply_to: reply.id }), messages: [reply], members }),
    { rule: 'reply', recipients: ['agent:sumi'] });
});

test('reply fallback ignores human messages, deleted messages and hub status messages', () => {
  const members = [member('agent:sumi')];
  const human = humanMessage({ id: 'fm_human_reply' });
  const deleted = agentMessage('fm_deleted', 'agent:sumi', { deleted_at: 1 });
  const status = agentMessage('fm_status', 'agent:sumi', { system: true });
  for (const target of [human, deleted, status, { ...agentMessage('fm_gone', 'agent:sumi'), deleted_at: 2 }]) {
    assert.deepEqual(routeRoomMessage({ message: humanMessage({ reply_to: target.id }), messages: [target], members }),
      { rule: 'none', recipients: [] }, target.id);
  }
  assert.deepEqual(routeRoomMessage({ message: humanMessage({ reply_to: 'fm_missing' }), messages: [], members }),
    { rule: 'none', recipients: [] });
});

test('agent-authored messages never route, even with typed mention entities', () => {
  const members = [member('agent:sumi'), member('agent:sora')];
  const routed = routeRoomMessage({
    message: agentMessage('fm_agent_turn', 'agent:sumi', { mentions: [mention('agent:sora')] }), messages: [], members,
  });
  assert.deepEqual(routed, { rule: 'none', recipients: [] });
});

test('unaddressed human messages are a no-op and non-members are not recipients', () => {
  const members = [member('agent:sora')];
  assert.deepEqual(routeRoomMessage({ message: humanMessage({ body: 'just talking' }), messages: [], members }),
    { rule: 'none', recipients: [] });
  assert.deepEqual(routeRoomMessage({
    message: humanMessage({ mentions: [mention('agent:ghost')] }), messages: [], members,
  }), { rule: 'none', recipients: [] });
  const removed = agentMessage('fm_removed', 'agent:ghost');
  assert.deepEqual(routeRoomMessage({ message: humanMessage({ reply_to: removed.id }), messages: [removed], members }),
    { rule: 'none', recipients: [] });
});

test('display names are irrelevant: routing is by actor id only', () => {
  const before = [member('agent:sora', 'Sora')];
  const after = [member('agent:sora', 'Completely Different Name')];
  const message = humanMessage({ body: '@Completely Different Name', mentions: [mention('agent:sora')] });
  assert.deepEqual(routeRoomMessage({ message, messages: [], members: before }),
    routeRoomMessage({ message, messages: [], members: after }));
  assert.deepEqual(routeRoomMessage({ message, messages: [], members: after }),
    { rule: 'mention', recipients: ['agent:sora'] });
});

test('routing accepts active members as ids or rows and ignores removed rows', () => {
  const message = humanMessage({ mentions: [mention('agent:sora')] });
  assert.deepEqual(routeRoomMessage({ message, messages: [], members: ['agent:sora'] }),
    { rule: 'mention', recipients: ['agent:sora'] });
  assert.deepEqual(routeRoomMessage({
    message, messages: [], members: [member('agent:sora', 'Old', { removed_at: 5 }), member('agent:sora', 'Sora')],
  }), { rule: 'mention', recipients: ['agent:sora'] });
});
