# Live chat events (hub features `live` (v1, 0.3.14) and `live2` (v2, 0.4.0))

> **Status:** v1 shipped in 0.3.14. v2 and everything under "0.4.0" below is implemented in the hub since 0.4.0-alpha (routes marked `x-foxfleet-status: implemented (0.4.0-alpha)` in `contract/openapi.json`). A hub without them answers 404: clients must check the matching feature in `GET /api/auth` → `hub.features`, never the version string.

## v1 (0.3.14): run notices, no text

`GET /api/live/stream`, login required (same auth as every `/api/*` route). Server-Sent Events.

Purpose: an open client learns at once that something happened in a chat it is showing, whichever client (web, another phone, a
bot connector) started it, and then fetches the newest page itself. **No message text is ever sent on this stream.**

## Frames

| frame | when |
|---|---|
| `retry: 2000` | first bytes |
| `event: foxfleet.gap` `data: {"cursor":"<epoch>:<n>"}` | the client's cursor is from an earlier hub process (restart) or older than the 500-event buffer: do a full catch-up |
| `id: <epoch>:<n>` `event: live` `data: {id,type,agent,chat,at,run_id?,state?,request_id?,kind?}` | replay after `Last-Event-ID`, then live |
| `event: foxfleet.ready` `data: {"contract":"foxfleet.live/1","cursor":"<epoch>:<n>","heartbeat_ms":15000}` | replay done (no `id`) |
| `: keep-alive` | every 15 s (`FOXFLEET_LIVE_HEARTBEAT_MS`): keeps Cloudflare (100 s idle limit) and other proxies open; clients treat 45 s of silence as a dead link |
| `event: foxfleet.auth` `data: {"reason":"signed_out"}` | the device's session ended; the stream closes, do not reconnect |

Types: `run_started`, `run_finished` (`state`: `done` / `error` / `stopped`), `approval`.

Resume with `Last-Event-ID: <epoch>:<n>` or `?after=<epoch>:<n>`; a bare id without the epoch is answered with `foxfleet.gap` (it cannot be checked against a restart). Without a cursor the stream starts at "now". At most 8 streams
per account (429). The bus is in memory: a hub restart changes the epoch, so every client gets `foxfleet.gap` and catches up.

## Client contract (Android 0.3.14)

- Hold the stream only while in the foreground; reconnect with backoff 1 s → 30 s (jitter), immediately when the app returns.
- On an event for the open chat: fetch the newest page, append messages after the last known id (replace the page if the last id is not in it).
- After every reconnect / gap: catch up the open chat and the agent list.
- Messages that never pass through the hub (the agent wrote from another app) are not on this stream: a newest-page check every 60 s (20 s without the stream) covers them.

---

# v2 (0.4.0-alpha, feature `live2`): gap-free account event stream

v2 is the single stream an app needs while it is open: new / edited / deleted messages, message status (sent, delivered, read),
typing, read state, unread counts and chat-list rows, plus the v1 run and approval notices. It is designed so a client can keep a
local cache (messages + chat list) exactly in sync: every persisted event has an account-wide sequence number, and a client that
was away resumes from its last number without losing or repeating anything.

## Selecting the version (backward compatibility)

| request | stream |
|---|---|
| `GET /api/live/stream` (no `v`) | **v1, unchanged.** 0.3.14 clients keep working byte for byte (`foxfleet.live/1`, `run_started` / `run_finished` / `approval`, per-process `<epoch>:<n>` ids). |
| `GET /api/live/stream?v=2` | v2 (`foxfleet.live/2`), frames below. |
| `?v=` anything else | `400 unsupported_version` |

v1 and v2 are separate cursors: never send a v1 id to v2 or the reverse (a foreign id is answered with a gap, below).

## Cursor

- Every persisted v2 event has `seq`: an integer per **account**, starting at 1, strictly increasing, never reused. It survives hub restarts.
- The SSE `id:` of an event is `<store>:<seq>`. `store` is a random id of the hub's data directory: it changes only when the hub's data is reset or restored from elsewhere.
- Resume with `Last-Event-ID: <store>:<seq>` (what EventSource sends) or `?since=<store>:<seq>` (alias `after`, as in v1; the query wins over the header). The hub replays every retained event with a larger `seq`, in order, then goes live.
- No cursor: the stream starts at "now" (nothing replayed). Take a snapshot first (`GET /api/chats` returns `cursor`) and connect with `since=<that cursor>`: then nothing that happened between the snapshot and the connect is lost.
- Retention: the newest **5000** events per account (`FOXFLEET_LIVE_RETAIN_EVENTS`, 100–100000), at most **7 days** (`FOXFLEET_LIVE_RETAIN_DAYS`, 1–90), and at most 32 MiB of event data. Events are persisted (one file per account, mode 0600, like the notification log).

### Gap

`event: foxfleet.gap` · `data: {"reason": "expired" | "reset" | "invalid", "cursor": "<store>:<seq>"}`, sent before `foxfleet.ready`.

| reason | when |
|---|---|
| `expired` | the cursor is older than the retained events |
| `reset` | `store` differs (hub data reset/restored) or `seq` is in the future |
| `invalid` | the cursor cannot be parsed (not `<id>:<digits>`) |

A v1 `<epoch>:<n>` id has the same shape as a v2 cursor from another store, so it is answered as `reset`.

After a gap the stream continues live from `cursor`. The client must resync: `GET /api/chats`, then for each cached chat `GET …/messages?after_n=<last n>` (or drop the cache for that chat). Store `cursor` as the new resume point.

## Frames

| frame | notes |
|---|---|
| `retry: 2000` | first bytes |
| `event: foxfleet.gap` | optional, see above |
| `id: <store>:<seq>` `event: <type>` `data: <Event>` | replay, then live |
| `event: foxfleet.ready` `data: {"contract":"foxfleet.live/2","cursor":"<store>:<seq>","store":"…","heartbeat_ms":15000}` | once, after the replay; no `id` |
| `event: typing` `data: <Typing>` | ephemeral, **no `id`, no `seq`**, never replayed |
| `: keep-alive` | every 15 s (`FOXFLEET_LIVE_HEARTBEAT_MS`); 45 s of silence = dead link |
| `event: foxfleet.auth` `data: {"reason":"signed_out"}` | the device session ended; the stream closes; do not reconnect |

Limits: 8 streams per account across v1 and v2 (`429 too_many_streams`); a client more than 1 MB behind is disconnected and resumes by id.

Ordering guarantees: events are delivered in `seq` order. For one chat, `message.new` for message `n` always comes before a `read` or `chat.updated` that counts it. `run.started` can come before the `message.new` of the user message that started it (a new chat learns its session id at launch): key runs on `run_id`. Clients **must ignore unknown event types and unknown fields** (new ones are added without a version bump).

## Event (common fields)

```json
{ "seq": 412, "type": "message.new", "at": 1792195200000, "agent": "nova", "chat": "20261017_101500_ab12cd", ... }
```

`agent` is the agent name (as in `/api/agents`). `chat` is the session id the client uses for history and sends; absent on account-wide events.

## Event types

| type | extra fields | meaning |
|---|---|---|
| `message.new` | `message: Message` | a message was added to a chat (from this app, another device, the web, the agent, or found by the hub's sync of a chat written elsewhere: `message.source = "external"`) |
| `message.edited` | `message: Message` | full replacement of a message the client may have (same `hub_id`). Also sent when the hub learns the agent's own id (`upstream_id`) or the final text of a streamed reply |
| `message.deleted` | `hub_ids: string[]`, `scope: "me"` | removed for this account (delete-for-me). `"all"` is reserved |
| `message.status` | `hub_ids: string[]`, `status` | status of the user's own messages moved forward (see Message.status) |
| `read` | `read_up_to: int`, `unread_count: int`, `agent_unread: int`, `total_unread: int` | this account's read position in `chat` moved (on any device). Positions only move forward |
| `chat.updated` | `row: ChatRow` | anything on a chat-list row changed (preview, unread, archived, muted, pinned, working, needs_input, label, avatar). Replace the cached row |
| `chat.removed` | — | the agent is gone (deleted, machine unpaired) |
| `run.started` | `run_id` | a reply started in `chat` (any client); follow it on `/api/agents/{agent}/runs/{run_id}/events` to stream it |
| `run.finished` | `run_id`, `state`: `done`/`error`/`stopped` | |
| `approval` | `request_id`, `kind` | the agent waits on a question or approval in `chat` |

Streaming text is **not** on this stream: it stays on the run's own stream. The finished reply arrives as `message.new` (or `message.edited` if the client already got a placeholder with the same `hub_id`).

### Message

| field | type | notes |
|---|---|---|
| `hub_id` | string | stable id given by the hub, never changes. Key your cache on it |
| `upstream_id` | string \| null | the agent's own message id once known (reactions and hide address this id) |
| `n` | int | position in the chat: 1, 2, 3 … per chat, gap-free, never reused (a deleted message keeps its number) |
| `role` | `user` \| `assistant` | |
| `text` | string | full text, at most 64 KB; when longer, `truncated: true` and the client fetches the message from history |
| `at` | int | Unix ms |
| `source` | `app` \| `web` \| `notification` \| `agent` \| `external` | where it came from |
| `status` | `sent` \| `delivered` \| `read` \| `failed` | user messages only: `sent` = stored by the hub; `delivered` = the agent accepted it; `read` = the agent started answering it; `failed` = it never reached the agent (`error` says why) |
| `reply_to` | string \| null | `hub_id` of the quoted message |
| `edited_at` | int \| null | |
| `run_id` | string \| null | the run that produced an assistant message |
| `images` | `{url, mime}[]` | short-lived media links, same rules as history. Not filled in 0.4.0-alpha: fetch the message from history for media |

Fields that are null or unknown may be left out of a `Message` (treat absent as null).

### Typing (ephemeral)

```json
{ "agent": "nova", "chat": "…", "state": "typing", "tool": null, "ttl_ms": 6000 }
```

`state`: `thinking` (reasoning), `typing` (writing the reply), `tool` (running a tool; `tool` is a short label, ≤ 80 chars), `idle` (stop
showing). The hub repeats a non-idle state at least every 5 s while it lasts; a client clears it after `ttl_ms` without a repeat, on
`idle`, on `run.finished` or on `message.new` from the agent in that chat. Typing is only about the agent; there is no user typing.

## Chat list (0.4.0, feature `chats`)

`GET /api/chats?archived=0|1` (default 0) → `{ "chats": ChatRow[], "cursor": "<store>:<seq>", "total_unread": int, "total_unread_all": int }`

One row per agent (FoxFleet's list is agents; an agent's sessions are its history). Order: pinned (by pin order), then by
`last_message.at` descending, then registry order. `cursor` is the v2 position the snapshot matches: connect the stream with `since=<cursor>`.
`GET /api/chats/{agent}` → one `ChatRow` (404 `chat_not_found`).

### ChatRow

| field | type | notes |
|---|---|---|
| `agent`, `label`, `kind` | string | as in `/api/agents` |
| `chat` | string \| null | the agent's most recent session (the one the app opens) |
| `last_message` | object \| null | `{hub_id, role, sender, preview, at, status}`; `sender` is `"you"` for the user, else the agent label; `preview` is plain text, ≤ 160 chars, markup and tool output removed, media as a short label (`Photo`, `Video`, `File: <name>`). `hub_id` is null when the preview comes from the agent's own session list before the hub numbered any message of that agent |
| `unread_count` | int | agent messages after the read position, over all of this agent's sessions, hidden messages excluded |
| `read_up_to` | int | read position in `chat` |
| `archived` | bool | |
| `muted` | `{until: int \| null}` \| null | from the notification mute (`PUT /api/notify/mute`); `until: null` = forever |
| `pinned`, `pin_order` | bool, int \| null | as in `/api/agents` (pin with `POST /api/agents/{name}/pin`) |
| `working`, `needs_input` | bool | a reply is running / a question or approval waits |
| `manual_unread` | bool | the user marked it unread |
| `updated_at` | int | Unix ms of the last change to the row |

`total_unread` counts unread over rows that are neither muted nor archived (the badge); `total_unread_all` counts every row.

Archive: `PUT /api/chats/{agent}/archive {"archived": true|false}` → `ChatRow`. An archived chat that is **not muted** returns to the
main list when the agent sends a new message; a muted one stays archived. Mute uses the existing `PUT /api/notify/mute`.
Mark unread: `PUT /api/chats/{agent}/unread {"unread": true|false}` → `ChatRow` (cleared by any read).
Each change is also pushed as `chat.updated`.

## Read receipts (0.4.0, feature `readReceipts`)

`POST /api/chats/{agent}/read` body `{"chat": "<session>", "up_to": <n>}` or `{"all": true}` → `{ "chat", "read_up_to", "unread_count", "agent_unread", "total_unread" }`

- Idempotent and monotonic: an `up_to` at or below the stored position changes nothing (200, current state). An `up_to` beyond the last message is clamped. `all: true` reads every session of the agent up to its newest message.
- Clears `manual_unread`. Pushes `read` (and `chat.updated`) to every stream of the account, so other devices update their badges.
- The **agent's** side (did the agent see my message) is `Message.status` (`delivered`, `read`), pushed as `message.status`.
- Sending a message in a chat through the hub (app, web or notification reply) reads that chat up to your message (`read` is pushed).
- The first time the hub sees a chat (opening it, or the chat-list sync) it numbers the existing messages silently: they do not become unread. A session the agent started after the agent was added to the hub, found by the sync (at most once a minute per agent, triggered by `GET /api/chats`), counts as unread. A user message written elsewhere does not move your read position.
- History gains the same numbering: `GET /api/agents/{name}/sessions/{id}/messages` adds `hub_id`, `n` and `status` per message when the hub has indexed them, and accepts `after_n=<n>` (oldest first, up to `limit`) for cache catch-up.

## Pull (0.4.0): `GET /api/live/events?since=<store>:<seq>&limit=<1..500>`

Same events as the v2 stream (no typing), as JSON: `{ "events": Event[], "cursor": "<store>:<seq>", "has_more": bool }`. For short
foreground resumes and background sync without holding a stream. `410 cursor_expired` (with `cursor` in the body) when the cursor is older
than retention or from another store: resync as after a gap. `400 invalid_cursor` when it cannot be parsed.

## Notification direct reply (0.4.0, feature `notifyReply`)

`POST /api/notify/reply`

```json
{ "agent": "nova", "chat": "20261017_101500_ab12cd", "text": "Yes, go ahead", "idempotency_key": "a5b0c6d2-…", "mark_read": true }
```

- **Auth:** the device's normal sign-in (`Authorization: Bearer …`), **or** a reply token in `X-Foxfleet-Reply-Token` (below). Either is enough.
- **Idempotency:** `idempotency_key` (8–100 chars of `[A-Za-z0-9_.:-]`) is required; the `Idempotency-Key` header is accepted instead. If both are sent they must be equal (`400 invalid_idempotency_key`). Keys are kept 24 h per account: the same key with the same agent/chat/text returns the original result with `200` and `duplicate: true`; with a different body `409 idempotency_conflict`. A RemoteInput retry after a network drop must reuse its key.
- **Response** `202`: `{ "message": Message, "session_id": "…", "run_id": "…" | null, "duplicate": false }`. The text is sent like a normal message (queued behind a running reply on Hermes, same as `POST /api/agents/{name}/messages` with mode `queue`). `run_id` is set when the reply started at once.
- `mark_read` (default `true`): the chat is marked read up to its newest message first, the way replying in a messenger reads the chat.
- `text`: 1–32 000 chars (`413 text_too_long`). Text only; no attachments.
- Rate limit: 30 replies per minute per account (`429 rate_limited`, `Retry-After`).
- Bot agents (connection `bot`) have no hub-side history: their messages are not numbered or pushed as `message.*`, and a notification reply to one is `409` (no `code`).

`POST /api/notify/read` body `{"agent", "chat", "up_to"?: n}` (no `up_to` = newest): the Mark-read action. Same auth (bearer or reply token), same result as `POST /api/chats/{agent}/read`.

### Reply token

A client that wants tokens opens the notification stream with `GET /api/notify/stream?reply=1`. Each `notify` event of type
`reply_finished` or `approval` then carries `"reply": {"token": "…", "expires_at": <ms>}`. The token is minted for **this device's stream
only** (it is never written to the notification log and differs per device), is valid **24 h**, and only for `POST /api/notify/reply` and
`POST /api/notify/read` on that event's agent and chat. It stops working when the device signs out or is revoked. A bad, expired,
revoked or out-of-scope token is `403 reply_token_invalid`, **never 401** (401 would sign the app out).

## Flags and compatibility summary

| feature in `hub.features` | adds |
|---|---|
| `live` | v1 stream (unchanged) |
| `live2` | `?v=2` stream, `GET /api/live/events` |
| `chats` | `GET /api/chats`, `GET /api/chats/{agent}`, archive, mark unread |
| `readReceipts` | `POST /api/chats/{agent}/read`, `hub_id` / `n` / `status` / `after_n` on history, `message.status` |
| `notifyReply` | `POST /api/notify/reply`, `POST /api/notify/read`, `?reply=1` tokens |

Nothing existing changes shape: new fields are additive, `/api/agents` keeps its unread-free rows, and the v1 stream is untouched.

v1 change in 0.4.0: its `429` body now carries `code: too_many_streams` (frames unchanged).

Hub environment (documented in `site/.vitepress/gen.mjs`): `FOXFLEET_LIVE_RETAIN_EVENTS` (default 5000), `FOXFLEET_LIVE_RETAIN_DAYS` (default 7).
