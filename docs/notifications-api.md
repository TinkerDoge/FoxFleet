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
data: {"contract":"foxfleet.notify/1","cursor":7,"dropped":0}

: keep-alive                 (comment, every 15 s)
```

- **Resume.** Send `Last-Event-ID: <last id seen>` (EventSource does this by itself) or `?after=<id>`. The hub replays every retained, unmuted event with a larger id, then `foxfleet.ready`, then follows live. No duplicates. A missing or invalid cursor (anything that is not plain decimal digits: `abc`, `-5`, `1e3`, `0x10`) means "from the start of the retained log"; a client with no state should call `GET /api/notify/events` first (or take `cursor` from `foxfleet.ready`) and not process history as new.
- **Gap.** The log keeps the newest 500 events. If your cursor is older than the oldest retained id, you get `foxfleet.gap` with `first` (oldest retained id) and `cursor` (newest). If your cursor is *newer* than the hub's (data was reset), you get `foxfleet.gap` and no replay: restart from `cursor`. After a gap, refresh the unread state by listing the chats.
- **Heartbeat.** A `: keep-alive` comment every 15 s (so a Cloudflare tunnel stays open). If nothing, not even a comment, arrives for ~45 s, treat the link as dead and reconnect with backoff (1 s → 60 s, jittered) and your last id.
- **Limits.** At most 8 open streams per account (`429` beyond that). A viewer that stops reading is dropped; reconnect and resume by id.
- **Sign-out closes the stream.** When the device behind a stream is revoked (`DELETE /api/auth/devices/{id}`), signed out (`logout`, `logout-all`, password change), disabled or removed, or its session expires, the hub sends `event: foxfleet.auth` with `{"reason":"signed_out"}` and closes the stream. For a session that simply ran out of age, the 15 s heartbeat notices within one tick. Do **not** reconnect after this frame (or after a `401`): go to the login screen.
- **Token rotation (Android).** The app's bearer token rotates about once a day: the response that triggers it carries `X-Session-Token: <new token>`, and the old token still works for 60 s. A stream request can be that request, so read `X-Session-Token` from the **stream response headers** too and store it before anything else, or the next reconnect after the 60 s grace gets `401`. (The hub sets the header before the stream starts; there is a test that it reaches the stream response.) A stream that stays open for days never sees the header again; the client picks it up on its next `/events` call or reconnect.

`FOXFLEET_NOTIFY_HEARTBEAT_MS` (hub environment) changes the heartbeat period; it exists for tests.

## Catch-up: `GET /api/notify/events?since=<id>&limit=<n>`

```json
{ "events": [ /* events with id > since, oldest first, muted ones included (muted: true) */ ], "first": 4, "cursor": 503, "gap": false }
```

`since` must be plain digits (`400` otherwise; default 0). `limit` defaults to 100 and is at most 500; `0`, negative numbers and non-numbers mean the default. `first` is the oldest retained id; `cursor` is the newest id.
`gap` is `true` when events after `since` were lost, that is `since > 0` and `since + 1 < first` (the log keeps only the newest 500), or when `since` is newer than the hub's `cursor` (hub data was reset). On `gap`, resync from `cursor` and refresh unread state from the chat list. With `limit` smaller than what is waiting, page by calling again with the last id you got. Use it on app open to learn what
happened while the service was down (and for unread dots, since it includes muted events).

## Retention and limits

The log keeps the **newest 500 events per account, with no time limit** (older ones are dropped by count; the cursor never goes back). It is saved to `notify.json` in the account's data directory, coalesced: changes inside 250 ms cost one write; a mute change is written immediately.
To stop a burst from flushing the log, `reply_finished` and `error` events are limited to **60 per minute per account**; the excess is dropped (not logged, not pushed) and counted: `dropped` in `GET /api/notify/prefs` and in the stream's `foxfleet.ready` frame is how many were dropped since the hub started (it resets on restart). A client can show "some notifications were skipped" when it grows. `approval` events are never dropped, and `test` has its own 10-per-minute limit on the route.

## Mute and master switch

Mute rules (checked when an event is created, so a mute never hides something that already happened):

1. master switch off → everything is muted (including `test`);
2. the agent is muted → muted;
3. the chat is muted → muted, **except `approval`**, which breaks through a chat mute (not an agent mute).

Muted events are still logged. Timed mutes expire by themselves.

- `GET /api/notify/prefs` → `{ "enabled": true, "storage": { "ok": true }, "dropped": 0, "agents": [{ "agent": "nova", "until": null }], "chats": [{ "agent": "nova", "chat": "h_abc", "until": 1791403600000 }] }` (`until` = ms epoch, or `null` = until unmuted). `storage.ok` is `false` (with an `error` code such as `ENOSPC`) when the last write of the log file failed: mutes and events still work in memory but would be lost on a hub restart; a Settings screen can show a hint. The hub also logs one `notify.save_failed` line (error code only) per minute, and retries a failed write by itself (1 s, 2 s, 4 s, 8 s, 16 s, then stops until the next change).
- `PUT /api/notify/prefs` body `{ "enabled": false }` → the same view. `enabled` must be a boolean.
- `PUT /api/notify/mute` body `{ "agent": "nova", "chat": "h_abc"?, "muted": true, "for_ms": 3600000? }` → the prefs view.
  Without `chat` it mutes the agent. `muted: false` clears it. No `for_ms` means until unmuted; otherwise 1000 ms to 366 days (`400` outside that).
  Unknown agent → `404`. At most 200 mutes per kind.
- `POST /api/notify/test` body `{}` → `{ "event": { …type "test"… } }`. At most 10 per minute per account, then `429` with `Retry-After: 60`. Use it for the Settings "test" button: if `event.muted` is true the master switch is off, so tell the user. The same event is pushed on the stream.

Errors are JSON `{ "error": "…" }` with the usual status codes (`400` invalid input, `401` login, `403` foreign Origin or untrusted host, `404`, `413` body over 4 KiB, `415` not `application/json`, `429` with `Retry-After` on `/test`). All are declared in `contract/openapi.json`.

On a clean hub shutdown (SIGTERM/SIGINT) pending events are written to disk before exit; after a crash (SIGKILL, power loss) the last ~250 ms of events can be lost, and ids may then be reused: a client holding a newer cursor sees `gap: true`.

## Not in phase 1

Quiet hours and per-category toggles, security events, cron and connection-lost events, action tokens (approve/deny from the shade),
Web Push, UnifiedPush and FCM. The event log is the shared source for all of them; the types above will grow, so ignore types you do not know.
