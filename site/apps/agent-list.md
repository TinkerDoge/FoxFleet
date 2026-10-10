# The agent list

The list is how you move between agents. On the web it is the sidebar (a drawer behind the menu button on phones); on Android it is the home screen.

![Android agent list: a pinned agent on top, previews, times, unread dots, Typing and Needs approval](/img/android-fleet-light.webp)

On the web (desktop):

![Web sidebar with the agent list](/img/web-agent-list-light.webp)

## What a row shows

- **Avatar and presence:** a colour tint and initials (or the emoji from the agent's *Avatar hint*), with a dot: green ready, amber online, grey offline.
- **Name:** the agent's name (not its description), one line.
- **Preview:** the last message of the last active chat, one plain line. Your own messages start with **You:**. Markdown, `MEDIA:` tags, addresses and anything that looks like a key or token are removed first. A picture-only reply reads *Photo*, *Video*, *Voice message* or *File: name*.
- **Typing…:** a reply is running right now. **Needs approval:** the agent is waiting for an answer or an approval (Hermes native chat).
- **Time:** the clock for today, *Yesterday*, the weekday within the last week, then a short date (with the year when it is not this year), in your language.
- **Unread dot:** the agent replied after you last opened this chat on this device. A new device starts with everything read.

## Order

1. **Pinned agents** first, in the order you pinned them (up to 50).
2. Everything else by **latest message activity**, newest on top. Rows slide to their new place (no animation when *Reduce motion* is on).
3. Agents with no messages yet follow, in the order set under *Manage agents*.

Pins belong to your account on the hub, so they follow you to every browser and phone. Last-activity data is also per account.

## Pin and unpin

- **Web:** hover a row and press the pin button, or right-click (long-press on a touch screen) and choose *Pin to top*. The same menu unpins.
- **Android:** swipe a row sideways, or long-press it and choose *Pin to top*. The long-press menu also has *Change picture*.

## Search

The magnifier (Android) or the field above the list (web) filters by name and by the preview text.

## Where the data comes from

The hub records, per account, the last message you sent and the last reply it relayed, and adds them to `GET /api/agents` as `last_activity_at`, `last_session_title`, `last_message_preview` and `last_role` (see the [API reference](/reference/api)). For API-key agents it also reads older chats from the hub's own history, so they show up straight away. Hermes agents show activity from the moment they are used through FoxFleet; chats you had elsewhere appear after the next message. The hub never sends addresses or hosts in these fields.
