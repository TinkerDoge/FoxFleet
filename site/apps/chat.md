# Chat

Pick an agent in the sidebar (web) or the list (Android). The header shows its name and whether it is online or ready.

## Replies

- **Streaming:** text appears as it is produced (Server-Sent Events). **Stop** cancels the reply. Screen readers get a polite "agent is replying / replied" announcement instead of every token.
- **Markdown:** headings, lists, tables, quotes, links and fenced code. Code blocks have a **Copy** button; wide tables scroll. Links open in a new tab with `noopener noreferrer`. All HTML is sanitized ([how](/security/media-proxy)); scripts, iframes and `javascript:` links are removed.
- **Remote images** in replies are loaded by the hub for you, so your IP is not exposed to the image host.
- **Reasoning:** reasoning text, when the agent sends it, is a collapsible block above the answer.
- **Tool / status line:** while the agent uses a tool you see a status line with a shimmer. With *reduce motion* on (OS setting or the app's own) the shimmer is a still highlight.

## Conversations

- **New chat** starts a fresh conversation (`/new`).
- **Sessions** (agents with the capability: Hermes, MCP inbox) lists earlier conversations; open one to continue it.
- Provider agents (OpenAI-compatible, OpenRouter, …) have no server history: the client sends the running conversation each time. Older images in long chats are collapsed to `[image]`.

## Layout

Desktop: sidebar with agents and tools, the chat in the middle. Phone: the sidebar is a drawer behind the ☰ button. Keyboard: `Enter` sends, `Shift+Enter` newline, `Esc` closes menus and the viewer; a *Skip to content* link is the first tab stop.

Next: [Attachments and voice](./attachments), [Commands](./commands).
