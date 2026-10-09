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

The message box works like Telegram or Discord: **text, Send and Stop** (plus attach and microphone). There is no mode picker. Just type and send.

- **A plain message while the agent works** redirects it. With a native Hermes session, Hermes applies the profile's own `busy_input_mode` (queue, steer or interrupt) and the answer appears as a small status under your message (*started*, *queued*, *steered*, *redirected*, *rejected*). Foxfleet never predicts it. With every other chat agent the reply is stopped, the hub waits until it really stopped, and your message is then sent as a new turn (*stop, then send*, not a live redirect).
- **`/steer <text>`** gives guidance to the reply in progress (Hermes with native steering). **`/queue <text>`** runs it after the current reply. **`/stop`** stops. All typed; there are no buttons for them.
- **`/model`** with nothing after it opens a picker in the chat: first the provider, then that provider's models (paged, searchable, Back and Cancel). Choosing one changes the model of **this conversation only**; the chat confirms it. `/model name --provider slug` does the same in one line. Commands with a fixed list of choices open the same kind of card. A card belongs to the chat that opened it and goes away after five minutes or when you switch chats.
- The Hermes profile default for messages sent while it works (`busy_input_mode`) is a **profile setting**, so it lives in the agent's settings (Agents, then your Hermes agent), with a warning and a confirmation, not in the chat.

Pressing **Stop** alone stops the reply, keeps what was written (marked *Interrupted*) and pauses the queue until you press **Resume queue** or send something new. Messages in the queue survive a reload, a second device and a hub restart (after a restart the queue stays paused until you resume it). You can take a queued message back.

Typing `/` opens the command list; choosing a command opens its choices (`/busy ` lists queue, steer, interrupt, status). `/queue <text>`, `/steer <text>` and `/stop` work as in Hermes, `/q` and `/s` are aliases. Commands the agent cannot run are shown greyed out with the reason.

::: warning Not verified against a live Hermes yet
Native runs (`/v1/runs`) and steering follow the Hermes documentation and were tested against a fake server. Until you have tried them on your own Hermes, treat Steer and Interrupt & send as experimental.
:::

## Hermes native sessions: questions, approvals, models

When the agent's machine has the Hermes checkout (see [Hermes](../agents/hermes.md)), the chat gains a few things. They appear only for those agents; for every other agent nothing changes.

- **Question and approval cards.** When Hermes needs an answer it shows a card under the reply. Answer once; the card goes away. If the agent cancels the question the card disappears, and after a reload or on another device the card is still there while the question is open. An approval offers *Allow once* and *Deny*. Anything else Hermes could ask (passwords, secrets) is declined for you right away instead of leaving the agent waiting.
- **What Hermes did with your message.** A message sent while it works shows Hermes's own answer: *started*, *queued*, *accepted as guidance*, *switched to it* or *did not accept it*. A queued message cannot be taken back, because Hermes holds the queue; the button says so.
- **Model and profile setting.** `/model` opens the picker described above; the profile-wide busy default is in the agent settings.
- **Tools.** The tools used during a reply are listed under the status line.
