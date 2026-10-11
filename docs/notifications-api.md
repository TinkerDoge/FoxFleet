# Notifications API (phase 1)

Hub-side contract for the Android service, the web app and anything else that wants "X replied / needs you / failed" without
holding a chat open. Contract name: `foxfleet.notify/1`. Feature flag: `notify` in `HUB_FEATURES` (`GET /api/auth` → `hub.features`, no login needed); an
older hub answers 404 on these routes, so check the flag first.

Everything is **per account**: a user sees only the events of their own agents. All routes need a login like every other `/api` route
(web cookie, or the app's `Authorization: Bearer <token>`); without one they answer `401`. Mutations need `Content-Type: application/json`.

## Event schema

One JSON object per event (same shape on the stream, in the catch-up list and in the log file):

| Field | Type | Meaning |
|---|---|---|
| `id` | integer | Cursor. Strictly increasing per account, never reused (also across hub restarts). **Muted events use ids too**, so a stream can show gaps in ids; that is normal. |
| `v` | 1 | Schema version. |
| `type` | `reply_finished` \| `approval` \| `error` \| `test` | See below. Unknown future types: ignore them. |
| `agent` | string \| null | Agent name, the same name used in `/api/agents/{name}/…`. `null` for `test`. |
| `chat` | string \| null | Session id of the chat (open it with `/api/agents/{agent}/sessions/{chat}/…`). `null` for `test`. |
| `priority` | `normal` \| `high` | Suggested importance: `approval` and `error` are `high`, `reply_finished` and `test` are `normal`. The client maps it to a channel and may downgrade (for example `error` for a chat that is not open). |
| `at` | integer | Hub time, ms since the epoch. |
| `muted` | boolean | True when a mute or the master switch applied when the event was created. Muted events are **not pushed** on the stream; they appear only in `GET /api/notify/events` (use them for unread dots). |

Extra fields by type:

- `reply_finished`: `run_id`. A reply that ended normally (any agent kind). A reply the user stopped is not an event.
- `error`: `run_id`, `message` (a fixed short sentence, `"The agent turn failed"`; never the model's text).
- `approval`: `request_id` (the id to answer with `POST /api/agents/{agent}/native/sessions/{chat}/requests/{request_id}`), `kind` (`clarify` for a question, otherwise the tool-approval method name). Only native Hermes sessions raise these today.
- `test`: nothing extra. Created by `POST /api/notify/test`; `agent` and `chat` are null.

**No message text, command text or question text is ever put in an event.** To show a body, the client fetches the chat.

The hub does not know whether the user is looking at a chat. Suppressing "reply finished" for the chat that is open on screen is the
client's job (the plan's rule: suppress everything except approvals).

## Stream: `GET /api/notify/stream`

Server-Sent Events, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. Frames:

```
retry: 3000

event: foxfleet.gap          (only when ids were lost, see below)
data: {"first":4,"cursor":503}

id: 7
event: notify
data: {"id":7,"v":1,"type":"reply_finished","agent":"nova","chat":"h_abc","priority":"normal","at":1791400000000,"muted":false,"run_id":"…"}

event: foxfleet.ready        (once, after the replay; carries no id)
data: {"contract":"foxfleet.notify/1","cursor":7}

: keep-alive                 (comment, every 15 s)
```

- **Resume.** Send `Last-Event-ID: <last id seen>` (EventSource does this by itself) or `?after=<id>`. The hub replays every retained, unmuted event with a larger id, then `foxfleet.ready`, then follows live. No duplicates. A missing or invalid cursor means "from the start of the retained log"; a client with no state should call `GET /api/notify/events` first (or take `cursor` from `foxfleet.ready`) and not process history as new.
- **Gap.** The log keeps the newest 500 events. If your cursor is older than the oldest retained id, you get `foxfleet.gap` with `first` (oldest retained id) and `cursor` (newest). If your cursor is *newer* than the hub's (data was reset), you get `foxfleet.gap` and no replay: restart from `cursor`. After a gap, refresh the unread state by listing the chats.
- **Heartbeat.** A `: keep-alive` comment every 15 s (so a Cloudflare tunnel stays open). If nothing, not even a comment, arrives for ~45 s, treat the link as dead and reconnect with backoff (1 s → 60 s, jittered) and your last id.
- **Limits.** At most 8 open streams per account (`429` beyond that). A viewer that stops reading is dropped; reconnect and resume by id.
- The stream is not closed when a device is signed out remotely; the next reconnect gets `401`. Handle `401` by going to the login screen, not by retrying.

`FOXFLEET_NOTIFY_HEARTBEAT_MS` (hub environment) changes the heartbeat period; it exists for tests.

## Catch-up: `GET /api/notify/events?since=<id>&limit=<n>`

```json
{ "events": [ /* events with id > since, oldest first, muted ones included (muted: true) */ ], "first": 4, "cursor": 503 }
```

`limit` defaults to 100, at most 500. `first` is the oldest retained id; `cursor` is the newest id. Use it on app open to learn what
happened while the service was down (and for unread dots, since it includes muted events).

## Mute and master switch

Mute rules (checked when an event is created, so a mute never hides something that already happened):

1. master switch off → everything is muted (including `test`);
2. the agent is muted → muted;
3. the chat is muted → muted, **except `approval`**, which breaks through a chat mute (not an agent mute).

Muted events are still logged. Timed mutes expire by themselves.

- `GET /api/notify/prefs` → `{ "enabled": true, "agents": [{ "agent": "nova", "until": null }], "chats": [{ "agent": "nova", "chat": "h_abc", "until": 1791403600000 }] }` (`until` = ms epoch, or `null` = until unmuted).
- `PUT /api/notify/prefs` body `{ "enabled": false }` → the same view. `enabled` must be a boolean.
- `PUT /api/notify/mute` body `{ "agent": "nova", "chat": "h_abc"?, "muted": true, "for_ms": 3600000? }` → the prefs view.
  Without `chat` it mutes the agent. `muted: false` clears it. No `for_ms` means until unmuted; otherwise 1000 ms to 366 days (`400` outside that).
  Unknown agent → `404`. At most 200 mutes per kind.
- `POST /api/notify/test` body `{}` → `{ "event": { …type "test"… } }`. Use it for the Settings "test" button: if `event.muted` is true the master switch is off, so tell the user. The same event is pushed on the stream.

Errors are JSON `{ "error": "…" }` with the usual status codes (`400` invalid input, `401` login, `404`, `429`).

## Not in phase 1

Quiet hours and per-category toggles, security events, cron and connection-lost events, action tokens (approve/deny from the shade),
Web Push, UnifiedPush and FCM. The event log is the shared source for all of them; the types above will grow, so ignore types you do not know.
