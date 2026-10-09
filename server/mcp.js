// The hub's MCP server (Streamable HTTP, JSON responses, stateless) for bridged mailbox agents
// such as Meta's Scribe. Each mcp-inbox connection has its own bearer token; the token alone
// decides which agent's inbox a call reads or writes.
import { fault } from './config.js';
import { threadId } from './inbox.js';

export const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const TOOLS = [
  { name: 'hub_get_messages', title: 'Get new messages from the user',
    description: 'Fetch messages the user sent you in Foxfleet that you have not received yet (oldest first). Each message is returned once. Call this whenever you check in; reply with hub_post_message using the same thread_id.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max messages to return (default 20).' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: false } },
  { name: 'hub_post_message', title: 'Post a message to the user',
    description: 'Send a message to the user in Foxfleet. Markdown is supported. Pass the thread_id from hub_get_messages to answer in that conversation; omit it to post in the most recent conversation.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 65536, description: 'Message text (Markdown).' }, thread_id: { type: 'string', description: 'Conversation to answer (from hub_get_messages).' } }, required: ['text'], additionalProperties: false },
    annotations: { readOnlyHint: false, idempotentHint: false } },
];

export function mcpHandler(inbox) {
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const text = (value, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(typeof value === 'object' ? { structuredContent: value } : {}), isError });
  function one(agent, msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid request');
    const notification = msg.id === undefined || msg.id === null;
    if (notification) return null;
    const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
    switch (msg.method) {
      case 'initialize': {
        const version = PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0];
        return ok(msg.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'foxfleet', title: 'Foxfleet', version: '0.2.0-alpha' },
          instructions: `You are connected to a Foxfleet hub as "${agent.label || agent.name}". Check in with hub_get_messages, then answer each message with hub_post_message using its thread_id.` });
      }
      case 'ping': return ok(msg.id, {});
      case 'tools/list': return ok(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
        try {
          if (p.name === 'hub_get_messages') {
            const limit = args.limit === undefined ? 20 : args.limit;
            if (!Number.isInteger(limit) || limit < 1 || limit > 50) return ok(msg.id, text('limit must be an integer from 1 to 50', true));
            return ok(msg.id, text(inbox.take(agent.name, limit)));
          }
          if (p.name === 'hub_post_message') {
            if (args.thread_id !== undefined && !threadId(args.thread_id)) return ok(msg.id, text('Invalid thread_id', true));
            return ok(msg.id, text({ ok: true, ...inbox.fromAgent(agent.name, args.thread_id, args.text) }));
          }
          return err(msg.id, -32602, 'Unknown tool');
        } catch (e) { return ok(msg.id, text(e.safe ? e.message : 'Tool failed', true)); }
      }
      default: return err(msg.id, -32601, 'Method not found');
    }
  }
  return function handle(agent, body) {
    if (Array.isArray(body)) { const out = body.map((m) => one(agent, m)).filter(Boolean); return out.length ? out : null; }
    return one(agent, body);
  };
}
export const bearer = (req) => { const v = req.headers.authorization; const m = typeof v === 'string' && v.match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/); if (!m) throw fault(401, 'Bearer token required'); return m[1]; };
