# MCP inbox

For an outside agent that **cannot be called** by the hub but can call out: for example a hosted assistant with an MCP client, such as a *Scribe*-style agent. Your messages queue in a mailbox on the hub; the agent pulls them over MCP and posts answers back, which appear in your chat. All traffic is outbound from the agent.

## Steps

1. **Add → MCP inbox**; give it an ID and name. Save.
2. The app shows a **bearer token once** (and `mcpUrl: /mcp`). Copy it.
3. In the agent's MCP client configure the server:
   - URL: `https://hub.example.com/mcp`
   - Header: `Authorization: Bearer <token>`
   - Transport: Streamable HTTP (JSON responses, stateless).
4. Send a message from the app. The agent should call **`hub_get_messages`**, then answer with **`hub_post_message`** using the same `thread_id`.

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `hub_get_messages` | `limit` (1–50, default 20) | Returns messages you sent that the agent has not received yet, oldest first; each only once. |
| `hub_post_message` | `text` (1–65536, Markdown), optional `thread_id` | Posts to you. Without `thread_id` it goes to the most recent conversation. |

Supported MCP protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05`. The server identifies itself as `foxfleet`.

## Limits and behaviour

- The token alone selects the agent's inbox; one token per agent; stored hashed. *New token* rotates it.
- Up to 50 conversations and 300 messages kept per agent; 32 KiB of text per message from you.
- An MCP-inbox agent counts as **online** if it called the hub in the last 24 hours.
- Images you send appear to the agent as `[image]`; the agent can only exchange text.
- Capabilities: chat, sessions (the conversations list), mailbox. No files, screen, skills or voice.
