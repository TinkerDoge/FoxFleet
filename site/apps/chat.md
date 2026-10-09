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


## History, resuming and slash commands

- **Closing the app or the browser does not stop a reply.** The hub keeps the agent running and buffers what it says. Reopen the app and the same chat is restored and keeps streaming. Only the **Stop** button stops it.
- **History** (clock icon in the chat header): your past sessions for this agent with title, time and a preview. Open one, rename it, delete it, start a *New chat*, pull to refresh, load more. Hermes agents use Hermes' own sessions; API-key agents (OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok Build) keep their history on the hub for 90 days by default (`FOXFLEET_HISTORY_DAYS`, `0` = keep nothing).
- **Old conversations** render like live ones: Markdown, code, tables, images, collapsed reasoning and tool steps, timestamps. Raw tool JSON and internal control tags are hidden.
- **Slash commands.** Type `/` for the list. Hermes agents show the full Hermes catalog, grouped, with argument hints. Commands marked *app* run in Foxfleet (`/new`, `/history`, `/stop`, `/retry`, `/title`), *chat* commands are sent to the agent as text, and commands that need a terminal or a messaging platform are shown greyed out as not available remotely. Other agent kinds only show the app commands and their skills.

- **Drafts.** On the web, text you have typed but not sent is kept per chat and restored after switching chats, reloading or closing the browser (text only, stored in your browser for your account, deleted when you send, start a new chat, delete the session or sign out).

## Sending while the agent works

The message box stays usable while a reply is streaming: **Send** and **Stop** are both there, with a small **send mode** next to them. It only offers what the agent can really do, and it remembers your choice per conversation.

| Mode | What happens |
| --- | --- |
| **Queue** | Your message waits and is sent after the current reply, in order. Works for every chat agent. |
| **Steer** | Adds guidance to the reply in progress, which keeps working. Only for Hermes with native run controls. "Guidance accepted" means Hermes took it, not that it has used it yet; if it never did, the text comes back once as a queued message. |
| **Interrupt & send** | Stops the reply, waits until it has really stopped, then sends your message as a new turn in the same chat. Over HTTP this is *stop, then start*, not Telegram's live redirect. The default for Hermes. If the stop fails, your message stays waiting with an error and nothing runs twice. |

Pressing **Stop** alone stops the reply, keeps what was written (marked *Interrupted*) and pauses the queue until you press **Resume queue** or send something new. Messages in the queue survive a reload, a second device and a hub restart (after a restart the queue stays paused until you resume it). You can take a queued message back.

Typing `/` opens the command list; choosing a command opens its choices (`/busy ` lists queue, steer, interrupt, status). `/queue <text>`, `/steer <text>` and `/stop` work as in Hermes, `/q` and `/s` are aliases. Commands the agent cannot run are shown greyed out with the reason.

::: warning Not verified against a live Hermes yet
Native runs (`/v1/runs`) and steering follow the Hermes documentation and were tested against a fake server. Until you have tried them on your own Hermes, treat Steer and Interrupt & send as experimental.
:::
