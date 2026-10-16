# Live chat events (hub feature `live`, 0.3.14-alpha)

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

Resume with `Last-Event-ID: <epoch>:<n>` or `?after=<epoch>:<n>`. Without a cursor the stream starts at "now". At most 8 streams
per account (429). The bus is in memory: a hub restart changes the epoch, so every client gets `foxfleet.gap` and catches up.

## Client contract (Android 0.3.14)

- Hold the stream only while in the foreground; reconnect with backoff 1 s → 30 s (jitter), immediately when the app returns.
- On an event for the open chat: fetch the newest page, append messages after the last known id (replace the page if the last id is not in it).
- After every reconnect / gap: catch up the open chat and the agent list.
- Messages that never pass through the hub (the agent wrote from another app) are not on this stream: a newest-page check every 60 s (20 s without the stream) covers them.
