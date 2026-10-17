# Changelog

All notable changes to Foxfleet. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/) (`0.x` is alpha: breaking changes can happen between releases; `config.json` v3 is the stable part).

## Unreleased (0.4.1-alpha)

Fixes from Doge's 0.4.0 test (main 8d1aa85): thinking that did not stream, no live tool/step detail ("Agent is working…", then the reply), and `/model` not opening the picker. Hub side on branch fix/0.4.1-hub (no UI or Android changes; Android is fixed on fix/0.4.1). All additions; every 0.4.0 frame keeps its bytes. Contract: docs/LIVE-EVENTS.md ("Step detail", "Model picker"), docs/API-ERRORS.md, contract/openapi.json.

- Hub (run stream, Hermes `/v1/runs` agents): `reasoning.available` is no longer dropped: it becomes the usual `reasoning_content` delta, only when no reasoning delta streamed in that run, so it is never shown twice.
- Hub (run stream): tool lifecycle on every path: `event: foxfleet.tool` now also on `/v1/runs` agents (`tool.start` / `tool.progress` / `tool.end`, a per-run `tool_id` when Hermes sends none), with `preview` (arguments, ≤ 200 chars) on start and `ok`, `duration_ms`, `result_preview` (≤ 500 chars, never the full result) on end, also for native gateway agents. `hermes.tool.progress` is sent once per tool on start (and for commentary, as before); `/v1/runs` no longer repeats it on completion.
- Hub (run stream): new `event: foxfleet.step` `{kind: commentary|status|subagent, text, level}` from Hermes `message.interim` (when not already streamed), native `status.update` and `subagent.start` / `subagent.complete`. Native `message.interim` was dropped before; it now also sends the commentary `hermes.tool.progress` line like `/v1/runs`.
- Hub (live v2): `typing` gains `label` (tool arguments, commentary or status line) and `tool_id`, only when known (a plain frame is byte-identical to 0.4.0); new ephemeral `event: run.step` (tool.start / tool.end / commentary / status, no id or seq, never stored, replayed or pulled); the reply's `message.new` (and `message.edited` / `message.new` from a resync) carries `reasoning` (≤ 64 KiB, `reasoning_truncated`) and `tools` (`{name, args?, result?, ok?}`, history shape, ≤ 50, ≤ 500 chars each).
- Hub (model picker): `capabilities.models` (`native` | `request` | `none`); `GET /api/agents/{name}/models` for native gateway agents and Hermes API-server agents (`/api/model/options`), `{mode, providers, override?}`; `POST /api/agents/{name}/sessions/{id}/model` `{model, provider?}` (or `{model: null}`) keeps a per-chat override in `chats.json` that the hub sends as `model` / `provider` with each new run of that chat (`/v1/runs` and chat completions). New error codes `models_unsupported` (409) and `invalid_model` (400).
- Contract: `info.version` 0.4.1-alpha; new schemas `RunStepEvent`, `RunToolFrame`, `RunStepFrame`, `ModelList`, `ModelOverride`; `TypingEvent.label` / `tool_id`, `LiveMessage.reasoning` / `reasoning_truncated` / `tools`, `Capabilities.models`; two new routes `x-foxfleet-status: implemented (0.4.1-alpha)`. No new environment variables. Package versions stay 0.4.0-alpha on this branch (bumped at release); Android unchanged.

## 0.4.0-alpha (not tagged)

Phase 1 of the chat-list work (contract at 48eb160: docs/LIVE-EVENTS.md, docs/API-ERRORS.md, contract/openapi.json). The entries below are the hub side (branch feat/tg-phase1, no UI or Android changes); the Android client for it is on feat/tg-phase1-android.

- Hub: live v2 (`GET /api/live/stream?v=2`, feature `live2`): a persistent per-account event log (`live-events.jsonl` + `.json` in the user's data dir) with a stable store id and `<store>:<seq>` cursors that survive restarts. Events: `message.new`, `message.edited`, `message.deleted`, `message.status`, `read`, `chat.updated`, `chat.removed`, `run.started`, `run.finished`, `approval`. Replay after `since` / `after` / `Last-Event-ID`, then `foxfleet.ready {contract, cursor, store, heartbeat_ms}`; a cursor the hub cannot continue gets `foxfleet.gap` with `reason` `expired` (older than what is kept), `reset` (other store, future seq, or a v1 id) or `invalid`. Ephemeral `typing` frames (typing / thinking / tool, 6 s TTL, repeated every 4 s, never stored). 15 s heartbeat, v1 and v2 share the 8-streams-per-account limit (429 `too_many_streams`), a client more than 1 MB behind is dropped. Retention: `FOXFLEET_LIVE_RETAIN_EVENTS` (default 5000), `FOXFLEET_LIVE_RETAIN_DAYS` (default 7), and at most 32 MiB.
- Hub: pull endpoint `GET /api/live/events?since=&limit=` (default 200, max 500) for clients that cannot hold a stream: `{events, cursor, has_more}`; 400 `invalid_cursor`, 410 `cursor_expired` (with the cursor to restart from).
- Hub: chats API (feature `chats`): `GET /api/chats` (one row per agent: preview of the last message, unread count, manual unread flag, archived, muted, pinned, working / needs_input; sorted pinned, newest, registry order; `archived` filter; `total_unread` excluding muted and archived, plus `total_unread_all`), `GET /api/chats/{agent}`, `PUT /api/chats/{agent}/archive`, `PUT /api/chats/{agent}/unread`, `POST /api/chats/{agent}/read`. A new agent message unarchives the chat unless it is muted. Messages from other clients and agent-side sessions are picked up by a background sync (at most once a minute per agent).
- Hub: read receipts (feature `readReceipts`): every message of an indexed chat gets a stable `hub_id`, per-chat number `n` and, for user messages, `status` (sent, delivered, read, failed; forward only). History (`GET .../sessions/{id}/messages`) returns them and accepts `after_n`. The agent counts as having read a message once its run starts working on it. Opening a chat for the first time numbers it silently (nothing becomes unread); sending reads the chat up to your own message.
- Hub: notification reply (feature `notifyReply`): `GET /api/notify/stream?reply=1` adds a 24 h reply token (one device, agent and chat; HMAC key `reply-token.key` in the data dir, mode 0600) to reply_finished and approval events. `POST /api/notify/reply` (idempotency key required, same key and text answers 200 `duplicate: true`, different text 409 `idempotency_conflict`; 30 replies per minute per account, 429 `rate_limited`; 413 `text_too_long` over 32000 characters; marks the chat read unless `mark_read: false`) and `POST /api/notify/read`, with either a session or the reply token (`X-Foxfleet-Reply-Token`, 403 `reply_token_invalid` outside its scope). Bot-API agents answer 409.
- Hub (from QA at 70a0140): a v2 replay of any size reaches `foxfleet.ready`: it is sent page by page and waits for the client to read (it gives up on a client that reads nothing for 60 s); the 1 MB "too far behind" drop applies only once the stream is live. Before, a replay over about 1 MB reset the connection with 0 bytes and the client reconnected forever.
- Hub (from QA): old events are aged out before a cursor is checked, so on an idle hub a cursor older than 7 days gets an `expired` gap / 410 instead of an empty, silent replay. After an unclean stop (crash, kill), every older cursor is an `expired` gap, because the last few ms of events may not have reached disk. The 32 MiB cap counts UTF-8 bytes, the event file is also compacted by size (at most about twice the cap) and read line by line at start.
- Hub (from QA recheck): SIGTERM / SIGINT with apps connected now stops cleanly: open event streams (live v1 and v2, notifications, run streams) are ended at once, other requests get up to 5 s, then the hub exits (well within Docker's 10 s grace). The live log records a clean stop, so clients resume by cursor after a deploy instead of all doing a full resync. A notification reply or mark-read for a chat the agent does not know (both history paths answer 404) is 404 `chat_not_found`, as documented, instead of 502.
- Hub (from QA): idempotency keys of notification replies are really kept 24 h (the cap is a full day at the rate limit, was 500 keys). A reply that is refused (bot agent 409, unknown chat 404, agent error) no longer uses a rate-limit slot.
- Hub: v1 live stream (`/api/live/stream` without `v`) unchanged byte for byte; its 429 body gains `code: too_many_streams`.
- Contract: the eight 0.4.0 routes are `x-foxfleet-status: implemented`; `ChatRow.last_message.hub_id` may be null (preview from the agent's own session list before the hub numbered a message). New site env vars documented.
- Privacy policy 1.1 (PRIVACY.md): the hub keeps the text of recent messages up to 7 days in `live-events.jsonl` and chat previews with read state in `chats.json`. The terms version users accept (`TERMS_VERSION` 1.0) is unchanged.
- Version 0.4.0-alpha (hub, web, site, contract). Android: versionName 0.4.0-alpha, versionCode 28 on feat/tg-phase1-android (53507cf); the hub branch alone leaves `android/` at versionCode 27 until the branches merge.

## 0.3.14-alpha (not tagged; Android versionCode 27)

- Fix (Android liveliness): new messages and task/status updates in the open chat now appear without reopening it from history. Root cause: the app had no live channel for a chat it did not send into itself; the open chat was only filled by its own reply stream, reopening a chat already in memory did not refetch, and only the fleet list polled (every 12 s). The notification stream only fed system notifications.
- Hub: live chat events `GET /api/live/stream` (feature `live`, docs/LIVE-EVENTS.md): per-account in-memory bus pushing `run_started`, `run_finished` (with `state`) and `approval` for every chat run, whichever client started it. No message text on the wire. Resumable by `Last-Event-ID` (`<epoch>:<id>`), `foxfleet.gap` after a hub restart or a buffer overrun, `foxfleet.ready`, heartbeat comment every 15 s (`FOXFLEET_LIVE_HEARTBEAT_MS`) so Cloudflare's 100 s idle cut never fires, at most 8 streams per account, signed-out devices are told (`foxfleet.auth`).
- Android: `LiveStreamRunner` holds the stream while the app is in the foreground (45 s read timeout = 3 missed heartbeats, backoff 1 s→30 s with jitter, immediate retry when the app returns). Events for the open chat fetch its newest page and append only what is new; a reply started elsewhere in the open chat is followed live; approvals refresh the card queue; any event refreshes the agent list (debounced). After every reconnect or gap the open chat and the list catch up. Fallback newest-page check of the open chat every 20 s without the stream (older hub) and every 60 s with it, for messages that never pass through the hub. Reopening a chat already in memory catches it up.
- Version 0.3.14-alpha, Android versionCode 27.

## 0.3.13-alpha (not tagged; Android versionCode 26)

- Hub: agent list (`GET /api/agents`) probes are cached ~10 s, shared between concurrent requests, give up after ~2.5 s (was 5 s), and a slow agent is answered from its last result within ~1.5 s; each agent carries `stale` + `checked_at` (contract/openapi.json, docs/API-ERRORS.md). One hung agent no longer makes every 12 s poll take 5 s.
- Hub: session history asks the agent dashboard and API server in parallel (dashboard preferred, API used if the dashboard fails or is >1 s slower) and fails with a specific `code`: `agent_offline`, `timeout` (504), `auth_failed`, `upstream_error`; every failure is logged (`history.failed`).
- Hub: the native session message list stops at the newest 50 instead of filtering the whole journal.
- Web: machines list refreshes every 30 s (was 8 s) and not while the tab is hidden; pairing status polls every 2 s only while a code waits.
- Android: fleet and pairing polls run only while the app is in the foreground; pairing stops once paired.
- Android tests: Robolectric runs under a test Application that keeps Coil off background threads (fixes the CI exit 134 JniConstants abort, coil#3049) and registers ComponentActivity for release unit tests (fixes 178 "Unable to resolve activity" failures); explicit `maxParallelForks = 1`.
- Version 0.3.13-alpha, Android versionCode 26.

## 0.3.12-alpha (not tagged; Android versionCode 25)

- Hub: the bot WebSocket (`/api/bot/ws`) no longer spends the per-IP login budget on authenticated upgrades; only failed credentials do. Valid reconnects use a per-bot connect bucket (429 when exceeded).
- Hermes plugin: a message held behind a gateway drain and then processed no longer risks a false "not processed, please resend" notice after a crash: a failed save of the held-record removal is retried immediately and then in the background, not only on the next reconnect. The retries never block the event loop.
- Hermes plugin tests: `FOXFLEET_TEST_NODE` / `FOXFLEET_TEST_HUB_SERVER` documented; real-hub tests in every module now skip with a reason when they are unset (they used to error).
- Android: fix the two release-lint errors (NotifyNotifier MissingPermission on the group summary: the notifications-enabled guard is now the first statement of `summary()`; AvatarStore NewApi WEBP_LOSSY on API 29). `lintRelease`: 0 errors, 75 warnings, 5 hints (JDK 17).
- Version 0.3.12-alpha, Android versionCode 25.
- Hermes plugin: the platform hint no longer tells the model the channel is text-only; it lists what 1.1 supports (images/files out, up to four images in, cards) and what it does not (custom buttons, reactions, threads).
- Hermes plugin: close 4003 (bot gone / account disabled / bot API off) and 1008 are handed to the Hermes gateway as retryable, so its 30 s→300 s reconnect queue brings the agent back; before, Hermes dropped them and, with FoxFleet as the only platform, stopped the gateway cleanly. 4001 and 4009 stay final by design. New tests run the real GatewayRunner fatal handler.
- Hub: `FOXFLEET_BOT_AGENTS` per-agent gate for the bot API, deny by default (unset/empty = no bot agent, with a start warning; `*` = all), plus `docs/BOT-API-ROLLOUT.md` (sumi-first rollout beside the connector, rollback, `stt.provider: local` pin). Production is not changed.

## 0.3.11-alpha (not tagged; signed candidate 2026-10-15, Android versionCode 24)

- Android renders bot approval/clarify cards without enabling Hermes-native model controls.
- Android applies `foxfleet.replace` to both the displayed stream and the stored assistant reply, including reconnects.
- Bot Stop and card callbacks require an explicit successful Hermes authorisation verdict; unknown checks fail closed.
- Native bot 1.1 includes Stop, scoped cards, hub-owned media and non-displacing standalone HTTP text delivery.
- Isolated DogeMint canary with a real Hermes gateway and `gpt-6.1-sol` passed text, clarify/replay rejection, Stop/recovery, byte-verified ZIP media and standalone delivery. The production bot feature flag remains off and existing agents/connector remain in service.


### Android test build
- Incremented Android versionCode to 21 for the signed Hermes-only test build; versionName stays `0.3.10-alpha`. This is not a new published release or the native bot-channel cutover.

### Removed: every non-Hermes agent kind (FoxFleet is Hermes-only)
- *Kinds:* the API-key chat kinds `openai` (OpenAI-compatible), `openrouter`, `zai` (Z.ai / GLM), `opencode` and `grok`, and the `mcp-inbox` mailbox kind are gone. `GET /api/agent-kinds` lists only `hermes` (the planned A2A and Webhook rows went too). Agents keep their `kind` field, so other kinds can come back later as clients of a hub bot API (see `design/notes/native-hermes-platform.md`).
- *Hub:* removed the shared OpenAI-style client, hub-side chat history and `GET/PUT /api/history/settings` (`FOXFLEET_HISTORY_DAYS`), the MCP endpoint `/mcp`, mailbox tokens and `POST /api/connections/{name}/token`. `capabilities.mailbox` is no longer sent and `capabilities.media.agent` is `native` or `http`.
- *Saved configs:* agents of a kind the hub does not run are ignored with one warning at start, kept in `config.json` exactly as they were (every save writes them back) and keep their names reserved. Old `inbox.json` and `history.json` files are left alone and still included in `foxfleet backup`.
- *Apps:* web and Android drop the mailbox token screens, the inbox chat polling and the history-retention client calls; the agent-type picker shows what the hub lists.
- *Docs:* the per-provider pages and the MCP inbox page are removed from the site; the API contract no longer has the removed routes and fields. The hub test floor is 342.

## 0.3.10-alpha (2026-10-13, Android versionCode 20)

### Changed: Android permissions and tests
- *Manifest:* declares `ACCESS_NETWORK_STATE` (the notification service listens for a returning network).
- *Tests:* Android unit tests run in forked JVMs (1 GB heap, a new fork every 8 classes), which stops the Robolectric exit-134 aborts; the hub test-count guard is raised to 349.

### Added: notifications on the hub (phase 1)
- *Events:* each account gets a small event log (newest 500, `notify.json`, mode 0600): `reply_finished` and `error` when a run ends, `approval` when a native agent asks. Events carry ids only, never message text.
- *Routes:* `GET /api/notify/stream` (server-sent events with `Last-Event-ID` / `?after` resume, a `gap` notice, 15 s heartbeat, at most 8 streams), `GET /api/notify/events`, prefs with a master switch, per-agent and per-chat mute (timed or until unmuted; approvals pass a chat mute) and a rate-limited test event. Documented in `docs/notifications-api.md` and the OpenAPI contract; `hub.features` gains `notify`.
- *Safety:* signing out, revoking or disabling a device closes its streams with a final `foxfleet.auth` frame; replies and errors are capped at 60 per minute per account (approvals never dropped, a `dropped` count is reported); saves are coalesced, retried after a failed write and flushed on a clean shutdown (SIGTERM/SIGINT).

### Fixed: model picker
- A pick of a model that Hermes guards (`confirm_required`) never switched, while Android even said "Model is now X". The hub and connector now relay the confirmation, and web and Android show a **Switch anyway** step with its own Cancel; a typed `/model X` opens the same card. `--GLOBAL` / `--Once` are refused like the lower-case forms.

### Added: notifications on Android
- *Service:* **Settings > Notifications** turns on a foreground service (type `remoteMessaging`) that holds the hub's `GET /api/notify/stream` open. Its own notification is a quiet, low-importance "Connected" line that tap-opens the app and changes to Connecting, Reconnecting or Offline. It resumes with `Last-Event-ID` (saved per account + hub), reconnects with a 1 s to 60 s jittered backoff, treats 45 s of silence as a dead link, reads the rotated `X-Session-Token` from the stream response before anything else, and never reconnects after `foxfleet.auth` or a 401 (it signs the device out of notifications instead). A `gap` frame refreshes unread chats from the hub instead of trusting the stream.
- *Alerts:* three channels (Replies, Approvals and questions, Errors) plus the quiet connection channel; approvals are high importance. Events carry ids only, so the text is fetched from the hub (the chat's last reply, the open approval). One notification per chat (MessagingStyle, grouped under one summary); tapping opens that exact chat (and its approval card), also from a cold start and after login. Opening a chat clears its notifications. A reply for the chat that is open on screen is not shown; approvals always are. The lock screen shows no message text. "Mute 1 h" is an action on every chat notification.
- *Settings:* master switch, per-category switches (replies, approvals, errors; kept on the phone), per-agent and per-chat mute for 1 h, 8 h, 24 h or until unmuted (the hub's mute routes), a status line (Connected, Reconnecting, Offline, Permission missing), a "Send test notification" button with clear success and failure lines, and a link to Android's channel settings when you switched one off there.
- *Permission (Android 13+):* a short explanation first, then the system dialog; after "Don't ask again" the section says so and opens the system settings.
- *Boot:* the service restarts after a reboot or an app update only if you turned notifications on and a login is stored. Signing out, or signing in as another account or on another hub, stops it and clears the resume id, the settings and every notification of the old pair.
- *Web:* Settings gets a small Notifications card (hub with the `notify` feature only): the hub-side master switch, agent mutes with a duration and an Unmute list, and a test button. The web app shows no alerts itself.
- *Hub:* needs hub 0.3.10-alpha with the `notify` feature; an older hub shows "too old" and the controls stay hidden.

### Fixed: review of the Android notifications
- *Login lost:* a single 401 or `foxfleet.auth` no longer wipes notifications. The service stops, the switch and the resume id stay, and Settings says "Log in again to get notifications" (kept across restarts). Only a real sign-out or another account/hub clears them; the next login resumes the service.
- *Threads:* the service reads chat state through a thread-safe map instead of a `HashMap` the UI also changes.
- *Bad event:* an event that cannot be turned into a notification is logged by id and skipped, so the stream moves on instead of replaying it forever; the service's own retry now uses the stream's backoff with jitter.
- *Rotation:* the notification link that launched the app is handled once; rotating the phone no longer re-opens the chat. A tap on a chat that no longer exists says so.
- *Connection:* the backoff resets only after the link stayed up 45 s, a returning network wakes a waiting retry, stopping the service cancels the open request, and an HTTP-date `Retry-After` is honoured.
- *Alerts:* an approval has its own notification, so a later reply or error in the same chat no longer replaces it. Revoking the notification permission while the service runs stops it cleanly (status "Permission missing"). "Mute 1 h" on a notification shows a message when it fails.
- *Settings:* a battery hint with a link to the system battery settings (we do not ask for the exemption). Note: turning notifications on in the app also turns the hub-side master switch on; turning them off only stops the service on this phone.

### Fixed: Android bot screen shown black while diagnostics said `blank:false`
- *Viewer:* the picture check now judges what is really visible: the displayed canvas size and the part of it inside the window and its container, and reports `collapsed`, `clipped` or `black` honestly (a 1440x900 canvas shown at 2x1 px used to read as fine). The page re-fits the picture to the window when it is collapsed or off-size, sizes its container to the window when that was a sliver, counts bytes received, and the diagnostics gain `verdict`, `canvas`, `scaleXY`, `box`, `visible`, `fixes`, `msgs` and `sample`. Not yet confirmed on a real phone.

### Added: chat backgrounds (web + Android)
- *Per chat:* a new **Background** button in the chat header (web: next to New chat and History; Android: the picture icon) opens a panel to choose **Default**, a **Colour**, a **Pattern** or a **Picture** for that conversation only. Changes show in the chat straight away. **Reset to default** removes the setting and the picture.
- *Colours and patterns:* 10 soft, theme-aware colours and 10 small tiling patterns (dots, grid, lines, waves, paws, foxes, topography, stars, diamonds, doodles). Patterns are drawn in the text colour at a low opacity set per pattern and per theme in `design/tokens.json` (`chatBackgrounds`); the same source feeds web and Android.
- *Pictures:* pick an image from the device (web file picker; Android system photo picker, no permission needed), then set **Blur** and **Dim** with live preview. The picture is scaled to at most 1600 px and stored as a small JPEG (or WebP/PNG when it has transparency, so see-through areas do not turn black).
- *Private:* the choice, the picture and both sliders stay on the device (web: localStorage + IndexedDB; Android: app-private preferences and files). Nothing is uploaded to the hub. **Sign-out keeps them**; they are removed only when a different account or a different hub signs in on that device (an owner key, account id plus normalised hub address, is stored next to them). A new chat keeps its look when it gets its id.
- *Readable on anything:* your own bubbles become opaque on a custom background, and loose text (notices, status, empty state) sits on a quiet chip.

### Fixed: chat backgrounds review (web + Android)
- Android: picture decode, EXIF turn, JPEG/PNG write and file moves now run off the main thread; the chat header on phones under 400 dp wide (or with large text) moves Screen, Chat background and History into a **More** menu so the agent name has room (targets stay 44 dp+); status text no longer wraps.
- Stars pattern opacity lowered to 0.12 (token source). Web: the picture's object URL is revoked on replace, chat change and unmount. Doodles and topography swatches show the whole tile instead of a clipped corner.

### Changed: slightly lighter dark theme
- *Dark background:* `bg` `#110F0E` to `#181514` (about +2.5 lightness points); `surface` and `surfaceAlt` move up with it so cards and bubbles keep their separation. Contrast tests still pass.

### Changed: attachment menu icons (web + Android)
- *Icons:* Photo library, Take photo and File now carry the shared icons (image, camera, file); the web attach button is a 44 px target and a file chip uses the file icon. Icons are decorative; the text stays the accessible name.
- *Icon set:* `wallpaper` and `reset` join the shared set.

## 0.3.9-alpha (Android versionCode 17)

### Added: message actions (web + Android)
- *Message menu:* long-press (Android; also on a picture inside a message) or right-click, long-press, the ⋯ button or the keyboard's context-menu key (web) opens a menu: quick reactions 👍 👎 ❤️ 🎉 😮 plus the full picker (an emoji you already gave is taken back), Reply, Copy, Select text (Android), Share, Retry, Edit, Delete for me. Retry shows on the newest reply only while it is the last message. Edit shows on your newest message once a reply follows it, for Hermes agents only, and neither shows while the agent is busy. Edit runs `/undo` and puts the text back in the box; if the agent refuses `/undo`, the text stays out and a notice says so.
- *Hearts and replies:* double-tap a message to heart it or take your heart back (touch only on web; a mouse double-click still selects a word). Swipe a message right to reply (Android; not from the screen's left edge, which stays the system back gesture). The empty chat hint now says "Long-press a message for more."
- *Replies:* a reply starts with a `> quote` line; both apps draw it as a reply bubble and the composer shows a "Replying to" chip. A slash command is sent as typed, without the quote.
- *Delete for me:* hides a message from your own view with an Undo line (web + Android) and keeps it in the agent's history. Hidden messages stay hidden on your other devices.
- *Hub:* `PUT`/`DELETE /api/agents/{name}/sessions/{id}/hidden` keep a per-account hidden list (the agent keeps the message); the reactions snapshot gains `hidden`. The list is cleaned up with the chat, agent or account, and the oldest entries drop when it is full.
- *Agents:* Hermes agents react by writing `REACT: <emoji>` on its own line; the hub shows it as the agent's reaction on your message, and the line is never shown (a reply that is only that line draws no row). `agentReactions` is now true for Hermes. The agent note gains one line (connector 0.3.9-alpha).
- *Icons:* `reply`, `share`, `selectAll` and `edit` join the shared set.

### Changed: shorter agent note, new foxfleet skill
- *Skill:* `skills/foxfleet/SKILL.md` is a Hermes skill with the full FoxFleet chat rules (files, reactions, reply quotes, question cards, remote slash commands, common mistakes). It also tells agents that older notes saying FoxFleet ignores `MEDIA:` are out of date. How to teach it: `docs/AGENT-AWARENESS.md`.
- *Agent note:* 7 lines down to 4 (658 to 481 bytes): the core `MEDIA:` and `REACT:` syntax, this machine's folders, size limit and upload folder, and a pointer to the skill. The question-card and slash-command lines moved to the skill. A new note version means an installed note shows as stale until `agent-note install` (automatic with `agentNote: true`).

### Fixed: hub test hang
- *Hub:* a connector link that closed while its forwarder servers were still being created left them listening, which kept the process (and the `ui-gateway` test file) alive until the test timeout. The link now remembers it is closed, closes late forwarders and serialises `expose()` calls; a deterministic regression test covers it.

### Compatibility / upgrade order
- *Order:* update the hub first, then the connector and the apps.
- *Apps 0.3.8 and older* show `REACT:` lines as raw text, and a reply that is only that line shows as a bubble.
- *New connector on an old hub:* the agent note tells Hermes about `REACT:`, but a 0.3.8 hub does not read it, so agent reactions are lost.
- *Delete for me* needs hub 0.3.9. The new apps hide the action on older hubs.
- *Downgrading the hub to 0.3.8* drops the hidden list the next time it writes `reactions.json`.

## 0.3.8-alpha (Android versionCode 16)

### Changed: one frame per message, quieter history, shorter agent note
- *Message frames (web + Android):* each message is one card that holds its reasoning, text, pictures, files and time; reactions hang on the card's bottom edge. Pointing at (web) or pressing (Android) a message outlines it, so it is clear what you react to. A reply being written already sits in the frame it keeps.
- *History:* Hermes' own notices (background-process results, delegation results, wake-ups, compaction context) no longer show as your messages when a chat loads; a skill turn shows as you typed it (`/review check PR 4`) instead of the whole skill text.
- *Connector 0.3.8-alpha:* the FoxFleet note for agents is about half as long (568 instead of 1297 characters) and says each thing once. If you opted in, the installed note updates on the next connector start; otherwise new chats get the new text.

## 0.3.7-alpha (Android versionCode 15)

### Added: messenger polish (web + Android)
- *Reactions:* react to any message with emoji (quick row plus the full searchable catalog, skin tones included); pills show counts and who reacted, humans and agents apart. Web: the smiley button on a message; Android: long-press (or the TalkBack action) and a bottom sheet. Changes show at once and roll back if the hub refuses. A second client picks them up within 30 s.
- *Hub:* reactions are stored per account (`reactions.json`) by stable message id and the signed-in actor (never an actor from the request). `PUT`/`DELETE /api/agents/{name}/sessions/{id}/reactions` are idempotent. Deleting a chat, an agent or an account removes its reactions; they expire after 90 days.
- *Hub:* API-key agent history now has persisted message ids (existing history is upgraded once on start), and inbox messages carry their id, so identical messages stay distinct.
- *Agents:* MCP inbox agents get a `hub_react` tool (`capabilities.agentReactions`). Reacting does not post a message or start a turn.
- Emoji artwork: [Twemoji](https://github.com/jdecked/twemoji) v17.0.3, bundled in both apps (no CDN), CC BY 4.0, credited in the picker and NOTICE.md.
- *Tool activity:* while the agent works, one short line per running tool ("Searching the web", "Running a command") with an icon; each line leaves when its call ends, all clear when the reply ends. Raw arguments never show. Native agents send per-call `foxfleet.tool` events; older ones keep the single latest label.
- *Clean history:* finished answers no longer show a "Used N tools" log, and tool-only rows are hidden.
- *Android media:* pictures and opened videos are kept in an account-scoped cache (256 MB, oldest removed first), so reopening a chat shows them without asking the hub again. Videos download when opened, with progress and Cancel. Settings shows the size and a **Clear cached media** button. Signing out clears that account's copies. Media requests send the hub token only to the hub itself.
- *Look:* warmer dark palette, softer assistant cards, slightly tighter spacing; the Android header shows Online/Offline and live activity shows once, under the reply.

## 0.3.6-alpha (Android versionCode 14)

### Added: agents know they are in FoxFleet
- *Connector 0.3.6:* chats are now created and resumed with `source: "foxfleet"`, so Hermes no longer tells the agent it is in its terminal UI (which also told it `MEDIA:` files do not work). A Hermes that does not know `source` is detected and the call is retried without it.
- *Connector:* a short, generated note (Markdown ok, `MEDIA:` files and which folders are shared, where attachments land, approval/clarify cards, which slash commands work, no terminal features) is written to the profile's `config.yaml` as `platform_hints.foxfleet` **only after you agree**: `foxfleet-connector doctor --fix` or `agent-note install` asks first (`--yes` to skip the question). A backup is kept once (`config.yaml.foxfleet.bak`), the edit is a marked block that touches nothing else, repeating it changes nothing, `agent-note remove` takes it out, and `agentNote: false` in the connector config turns the feature off. `doctor` and `agent-note status` report each profile (installed, out of date, missing, yours, unsupported, off).
- *Connector:* if you decline, or Hermes has no `platform_hints`, the same note rides once on the first message of each new chat (the hub hides it again in the transcript).
- Note wording: `contract/agent-note.golden.txt`. Details: docs/AGENT-AWARENESS.md.

### Fixed: pictures you send now reach the agent and show in chat (Android + web)
- *Hub:* on native Hermes chats a picture you attached was turned into the text "[image]" and never sent. It is now handed to Hermes (`image.attach_bytes` through the connector's new `attachimg` op) together with your message. *Needs hub and connector 0.3.6.*
- *Android:* pictures use one loader (`ChatImage`) with a spinner, a "Couldn't load this picture" tile with **Retry**, and a fallback to the embedded copy when the cached file is gone (history reloads no longer show a blank bubble).

### Fixed: Bot computer view still black
- A black picture is often a truly empty remote desktop (virtual display with no window manager or wallpaper). The viewer now samples the canvas and says "Connected, but the machine's screen is empty" with **Restart desktop** (new hub `stop`/`restart` screen actions) and **Reconnect**; "no picture arrived" is its own message.
- **Screen debug** (Settings, or long-press the title): on-screen strip with state, size, frames, bytes, last error; **Send diagnostics** copies a report (app, WebView, console log). JavaScript console messages are written to logcat.
- The viewer page sizes itself with `100dvh` and a resize observer, so a WebView that reports 0x0 before layout no longer leaves a zero-size canvas. Starting a desktop waits up to 95 s.
- Not verified on a phone: no emulator was available here. See docs/TROUBLESHOOTING.md.

### Added: reasoning (thinking) shown above replies
- Collapsed "Reasoning" block (lightbulb, "Thought for 8 s", shimmering "Thinking…" while streaming), tap to expand, muted Markdown, limited height with "Show all", Copy; open state is remembered per message. Settings > **Show reasoning** (default on).
- *Hub:* `reasoning_content`, `reasoning`, `reasoning_text`, `thinking` fields and `<think>`/`<thinking>` tags (even split across chunks) are normalised into `reasoning_content`; native Hermes `reasoning.delta`, `reasoning.available` and `message.complete.reasoning` are merged without repeats. It is never part of the reply text. Vectors: `contract/reasoning.vectors.json`. Details: docs/REASONING.md.

### Changed: tests
- `npm test` now runs `scripts/check-hub-tests.mjs`: fails if fewer tests ran than `scripts/hub-tests.min`, or any was cancelled or failed. `--test-force-exit` was dropped (`--test-timeout` stays); `npm run test:raw` is the plain runner.

## 0.3.5-alpha (Android versionCode 13)

Fixes from testing 0.3.3 / 0.3.4 on a phone against a self-hosted hub behind Cloudflare. **The hub needs the new build** for the items marked *hub*; apps and connectors tell you when it is older.

### Fixed: Bot computer view (screen takeover)
- *Hub:* starting a virtual desktop on a cold machine took longer than the 20 s call limit and failed with a blank viewer; it now waits up to 90 s. A gateway restart that forgot the viewer now answers `reopen` and the apps reopen once on their own.
- *Hub:* screen failures carry a machine-readable `code` (`machine_offline`, `display_unsupported`, `gateway_unreachable`, `dashboard_auth`, `timeout`, `reopen`), and `GET /api/auth` reports `hub.version` and `hub.features`.
- *Apps:* the viewer never stays blank: named messages for offline machine, no VNC / not installed, Hermes too old, expired sign-in, unreachable hub, timeout and **hub too old**, plus a timeout when the WebView page never starts. Shared vectors: `contract/screen-problems.vectors.json`.
- *Apps:* touch controls: tap = click, long-press = right-click, drag, two-finger scroll, pinch zoom with Fit / 100%, a keyboard button and a key row with Esc, Tab, Enter, arrows and sticky Ctrl, Alt and Shift.
- Docker image and release tarball now include `package.json`, so the hub reports its real version.

### Fixed: agents sending pictures, videos and files
- *Hub:* media made by tools reaches the chat even when the model writes no tag: paths in tool results (image generation, screenshots, files a tool wrote or sent), Markdown pictures and `data:image/…` pictures become cards. Checked against a real Hermes `tui_gateway` with a fake model (a real `write_file` call).
- *Connector 0.3.5:* shares every profile's own cache folders and `HERMES_MEDIA_ALLOW_DIRS`; new `foxfleet connector allow-media <folder>`; `doctor` lists shared folders and warns about bad entries; reports its version and features to the hub.
- *Apps:* a card that cannot load says why ("Not available: outside shared folders" with a **Copy fix** command, file gone, too large, wrong type, machine offline, hub too old, sign in again) instead of a generic message. Each agent's test shows a **Media** row with the hub and connector versions.

### Fixed: no time or preview on agent cards
- *Hub:* Hermes agents are seeded once from their newest session (any profile, connector or old `/chat` path); ISO session times are understood. `FOXFLEET_DEBUG=1` logs `activity.seed` lines.
- *Apps:* the last message each device sent or received is kept locally as a fallback; Settings shows a quiet "Update your hub" note when the hub reports no features. Tested against a real `/api/agents` answer (`contract/agents-activity.sample.json`).

### Fixed: chat scroll
- Web and Android: open at the newest message (also after history and late layout changes), a round go-to-bottom arrow after scrolling up, a **New message** pill with a count that never moves the view, pinned streaming, "load earlier" keeps your place, resets on chat switch, reduced motion respected. Shared vectors: `contract/scroll-follow.vectors.json`.

### Docs
- Screen takeover and media troubleshooting, a hub / connector / app compatibility table, scrolling, agent list fallbacks, `allow-media`.

## 0.3.4-alpha (Android versionCode 12)

### Added: a Telegram-style agent list, sorted by activity, with pins
- **Order:** pinned agents first (in the order you pinned them, up to 50), then newest message activity, then agents with no messages in registry order. The manual order under *Manage agents* is now only the tie-break. Pins and last-activity data are per account on the hub.
- **Rows** (web sidebar and Android home): avatar with presence dot, name (not the description), one-line preview of the last message (`You: ` for your own; *Typing…* while a reply runs; *Needs approval* for an open Hermes request), right-aligned time (clock today, *Yesterday*, weekday this week, short date, locale aware), unread dot, pin mark. Search by name or preview.
- **Pin / unpin:** web: row button or right-click / long-press menu. Android: swipe a row or long-press it (the menu also has *Change picture*). Reordering animates (FLIP on web, `animateItem` on Android) and honours Reduce motion.
- **Hub:** `GET /api/agents` adds `last_activity_at`, `last_session_title`, `last_message_preview` (140 characters, plain text: no Markdown, `MEDIA:` tags, addresses or secret-looking values), `last_role`, `pinned`, `pin_order`, `working`, `needs_input` and returns the list sorted; new `PUT /api/agents/{name}/pin`. Updated when you send and when a reply ends, whatever path it took; older API-key chats seed it from the hub's history. Stored per user in `activity.json`. Never contains an address or host.
- Shared rules and vectors: `contract/agent-list.vectors.json` is checked by the hub, the web app and Android (order, preview line, time labels).

### Changed: polish
- Design tokens for motion (message-in 180 ms, status 180 ms, panel in 240 / out 150 ms, typing loop 600 ms with 150 ms phase) and the 44 px touch target; reduced-motion zeroes them.
- Incoming messages fade, scale from 0.96 and rise 8 px (only messages that arrive after the history is shown); a three-dot typing indicator and a status line that cross-fades in a fixed slot; the "Completed" line fades away; skeleton rows instead of "Loading…" text.
- Agent replies are soft surface cards, yours tinted pills; Android settings: profile card, rows with chevrons, sentence-case section labels, 20 dp cards; rounded circular header and tool buttons (web sidebar tools are icon buttons, so *Sign out* no longer wraps); a back button that is a circle.
- Fixed: the web composer drew a border and a second outline when focused; the web header buttons *Screen* and *New chat* touched; the drawer's agent list was clipped by the tools block on phones.

## 0.3.3-alpha (Android versionCode 11)

### Fixed: short outages (Cloudflare blips) no longer end sessions
- **Root causes found.** (1) *Connector:* a failed WebSocket handshake (the tunnel answering 502 to the upgrade) never triggered a retry, so a machine stayed dead until restarted; a link that went silent without closing was never noticed. (2) *Hub:* after a link flap nothing re-subscribed to the native Hermes events, so a turn that finished during the outage never ended in the UI. (3) *Web and Android:* any 401 signed the user out even when the hub could not be reached to confirm it; the boot call fell back to the hub-address screen on a 502; stream resume gave up after ~30 s (and on web re-used an already-consumed response); a send lost in a blip showed an error and the draft.
- **Sign-out only on a real 401 from `/api/auth`.** Both clients now ask `/api/auth` before treating a 401 as a lost session; "cannot tell" counts as transient. 502/503/504/52x, timeouts and resets are never a sign-out and never a run failure.
- **Retry with exponential backoff and jitter** for idempotent GETs, and **stream resume** from the cursor (`?after=` / `Last-Event-ID`) for about three minutes. A small, non-blocking **Reconnecting…** line replaces error banners (web and Android), including at app start.
- **A send that was cut off by a blip is found or resent once**, with the same `client_id`, so the hub never runs it twice.
- **Hub:** event streams send a `retry: 3000` hint and an immediate first byte (15 s keep-alives, `Cache-Control: no-transform`, `X-Accel-Buffering: no` were already there); runs keep going when the client disconnects; when a machine reconnects the hub re-attaches live native sessions and back-fills the events it missed.
- **Connector:** reconnects after a failed handshake, jittered backoff (1 s up to 60 s), a 75 s silence watchdog (`FOXFLEET_LINK_SILENT_MS`) for half-open links, re-registers and re-attaches without restarting agent turns.
- **`foxfleet doctor`** now tests the public address for streaming (new `GET /health/stream`): it warns when a proxy or tunnel buffers responses and says what to change. Recommended Cloudflare settings: [Hosting → Cloudflare Tunnel](/hosting/cloudflare-tunnel#resilience).
- Tests: a fault-injecting proxy (502 storms, resets, frozen links) in front of the hub for web, hub, connector and Android.

### Changed: debug and release install side by side (Android)
- The debug build is now `dev.foxfleet.app.debug`, labelled **FoxFleet Debug** with version name `…-debug` and a DEBUG-badged launcher icon; release stays `dev.foxfleet.app` / **FoxFleet**. Separate data and sign-in. File sharing uses `${applicationId}` so both work. Both register `foxfleet://`, so Android may ask which app opens a link. CI artifact paths and the release APK name are unchanged.

### Added: pictures, video, audio and files from agents (`MEDIA:` tags)
- Hermes tags files it wants to send with `MEDIA:/path/file.png` (or an `https://` URL, optionally with `[[audio_as_voice]]`). The native Hermes gateway passes those tags through as plain text, so Foxfleet now reads them itself, over the native path and the HTTP path: the tags (and Markdown images with local paths) are removed from the text and shown as **image, video, audio (voice) and file cards** on web and Android; tap a picture or video for the fullscreen viewer. Old chats show them too.
- **Local files** on the agent's machine are fetched by the connector (only inside its shared folders, an extension allowlist with content sniffing, symlinks resolved, 25 MB cap, 60 per minute) and served by the hub to the owning user only through a signed link that expires in 15 minutes. Remote URLs go through the SSRF-guarded fetcher. The hub only serves what the agent actually mentioned. See [Pictures, video and files from agents](/apps/agent-media) and [Security → agent media](/security/media-proxy#agent-media).
- New endpoints: `POST /api/agents/{name}/media`, `GET /api/media/{token}`, `GET /health/stream` (see `contract/openapi.json`). One parser with shared test vectors (`contract/media-tags.vectors.json`) runs in the hub, web and Android.
- Verified against a real Hermes `tui_gateway` with a fake model (opt-in test `server/test/media-real.test.js`).

## 0.3.2-alpha (Android versionCode 10)

### Fixed
- **Opening a non-default Hermes profile signed people out (phone) or looped the page (web).** When a profile's Hermes answered 401 to the hub, the hub passed that 401 on, and both clients read it as "your login ended". The hub now answers 502 ("the agent did not accept the hub's credentials"), and the web client and the Android app only sign out when `/api/auth` itself says the login is gone. Regression tests: hub (one machine, three profiles, one rejecting), web client and router (profile names with `/ : @ + %` and spaces), Android.

### Changed
- **Android: the burger button and agent drawer are gone.** Switch agents with Back; chats are in the History button. Settings, sign-out and Add agent stay on the agents screen.
- **Both apps: the extra `/` button is gone** (typing `/` and `/help` are the way in).
- **`/model` pickers** (web card, Android sheet): the provider list is now searchable and paged like the model list, both are a fixed height with Previous / Next and "Page n of N".
- **One rounded icon set on web and Android** (Material Symbols Rounded, Apache-2.0, bundled as path data: no font or CDN download; see `NOTICE.md`, `design/icons`, `node design/tools/gen-icons.mjs`). Used in navigation, the composer, menus and empty states.
- **Real buttons instead of text links** across both apps: soft tonal buttons for secondary actions, filled for the main action, outlined for quiet ones, with pressed states.

## 0.3.1-alpha (merged batch, not tagged)

### Added
- **Slash menu parity (web and Android).** Bare `/` lists the commands that can run plus skills, with no 60-row cut-off; aliases and commands that cannot run from here appear when their name is typed (or description words). `/help` and `/palette` open a searchable command browser. A connected Hermes gateway adds that profile's skills and any extra names it discovered (shown, never executable: discovery is not permission). The catalog can be scoped to a chat (`?session=`). See `docs/HERMES-SLASH-PARITY.md`.

### Changed
- **UI audit stage 1 (web).** Reliable chat navigation and history (route follows the open chat, Back/Forward, stale responses ignored), recovery actions on errors, run status line, accessible action menus (attachments, secondary header actions), modal drawer focus handling, a real chat heading and 320 px / large-text layouts. Android theme tokens and fleet screen contrast adjusted.

## 0.3.1-alpha

### Changed (chat feels like Telegram/Discord)
- **The composer is text, Send and Stop.** The send-mode selector, the "Chat controls" button and the extra row above the composer are gone on web and Android. This also fixes the Android phone layout the extra header button broke (checked at 360 dp and 411 dp, with a large font scale and a shrunk viewport for the keyboard).
- **No mode picking.** A plain message sent while the agent works redirects it: native Hermes applies its own profile `busy_input_mode` and the real answer is shown as a small status on the message; other agents stop, wait for confirmed termination, then send.
- **Typed commands:** `/steer <text>`, `/queue <text>`, `/stop`. `/busy` now only points to the setting.
- **`/model` picker.** Bare `/model` opens a two-step card (provider, then models: paged, searchable, Back/Cancel); the choice is session-scoped and confirmed in the chat. The same card pattern serves any command with fixed choices (a bottom sheet on Android, a card in the stream on web). Cards belong to the chat that opened them and expire after five minutes.
- **The Hermes profile default for busy input moved to the agent's settings** (web and Android) with its warning and confirmation.

### Fixed
- Flaky native tests: the connector now waits for the gateway's stdout to drain before reporting that it exited; a late acknowledgement after the gateway went down is `uncertain`; the facade never opens a second run for a turn that ended while the send was in flight.

## 0.3.0-alpha

Android `versionName 0.3.0-alpha`, `versionCode 7`. Not yet published. Implements stages 1 to 6 of `docs/HERMES-CHAT-CONTROLS.md`; stage 7 (a Telegram adapter) is out of scope. Source-level and fake-upstream tested only: **Hermes native runs need a live check** (see the roadmap).

### Added

- **One entry point for every client.** `POST /chat`, `POST /messages`, `GET /queue` and the `/runs/{id}/events|stop` endpoints of a native-capable Hermes agent (`capabilities.nativeUi`) are routed to the native session on the hub: the same shapes the apps already speak, so web and Android do not each switch routes. HTTP-runs, Grok/OpenAI-compatible and MCP-inbox agents keep their previous paths untouched. The reply is followed as a normal resumable run; a turn Hermes starts by itself from its own queue gets a run too. The hub keeps no queue for native sessions: it lists what Hermes acknowledged and still holds (Hermes shows only the head of its queue and pops it first-in-first-out, so earlier messages are marked delivered).
- **Approval and question cards** (web and Android). `clarify` and `approval` requests arrive as `foxfleet.request` events, are answered once by id, close on `foxfleet.request_closed` (answered, cancelled, interrupted), and come back from `GET /queue` (`open_requests`) after a reload, a reconnect or on a second device. Any other request kind (sudo, secrets, vault, GUI reads) is declined upstream at once so the agent never waits for a timeout, and never becomes a card. Approvals offer *Allow once* and *Deny* only.
- **Honest acknowledgements.** Each message sent while Hermes works shows what Hermes itself answered (*started / queued / accepted as guidance / switched to it / did not accept it*), `uncertain` after a hub restart until reconciled. Nothing is predicted by the app. A queued message cannot be taken back (Hermes owns the queue): the control is disabled with that reason; a refused message can be dismissed and its text is kept.
- **Send modes named for what they do.** Native: *Queue*, *Steer*, *Redirect* (a live redirect Hermes may refuse; the answer is shown). HTTP and other agents: *Interrupt & send* stops the reply, waits for it to end, then sends. Tooltips and the send button say which.
- **Chat controls (native agents).** A model picker (`models`/`setmodel`, **this conversation only**; `--global` is refused) and the Hermes **profile** default for messages sent while it works, shown with a warning and changed only after confirmation (`GET/POST …/native/busy`). `/busy` in the composer stays a per-chat choice of this app and says so.
- **Tool list.** The tools used during a reply are listed under the status line.
- **Native gateway discovery and `doctor`.** The connector finds the gateway from `uiGatewayCommand`, `FOXFLEET_HERMES_GATEWAY_CMD`, `hermesAgentDir`/`HERMES_AGENT_DIR`, a checkout next to the Hermes home (`hermes-agent`, `~/hermes-agent`, `~/.hermes/hermes-agent`) or the interpreter of the `hermes` launcher on PATH. `foxfleet connector doctor` (and `foxfleet doctor` on a computer with a paired connector) reports what it found, starts the gateway to prove it works, and prints a fix.
- **Native Hermes sessions through the connector (hub, connector, web and Android).** When the machine has a Hermes checkout, the connector owns one long-lived `tui_gateway` per shared profile and relays a fixed allowlist of actions (create, attach, events since, submit, steer, redirect, interrupt, commands, models, `/model` for one session, approval and clarification answers) over the existing outbound tunnel. The hub adds ownership checks, a message journal (what was sent, what Hermes acknowledged: streaming, queued, steered, redirected or rejected), a versioned `foxfleet.native/1` event stream with a replay cursor and any number of viewers, and snapshots that restore the partial answer, queued prompts and open questions. Hermes schedules those turns itself, so the hub does not keep a second queue for them. Capability order: native UI, then `/v1/runs`, then chat completions. Protocol notes: `design/notes/hermes-ui-gateway.md`. Tested against a protocol-faithful fake in CI and, by hand, against a real Hermes gateway (`0670ba45`) with a local fake model.
- **Type to run, with choices.** `/` opens a searchable command list; picking a command opens its choices (`/busy ` lists queue, steer, interrupt and status, `/busy st` filters). Aliases resolve (`/q`, `/s`), free-text arguments and `#` skills are left alone. The catalog is per agent (`GET /api/agents/{name}/commands`) and says what each command does (`handler`, `busy` policy, `executable`, `disabledReason`); commands without a verified route are disabled with a reason, and generic agents never show Hermes commands.
- **A composer that works while the agent works** (web and Android): Send and Stop are both available, with a small send-mode selector limited to what the agent supports: **Steer**, **Queue**, **Interrupt & send**. The choice is remembered per conversation; Hermes defaults to Interrupt & send. Labels are honest: *Interrupt & send* stops the reply, waits until it has really stopped and then sends a new turn (over HTTP this is not a live redirect); *Guidance accepted* is not *used*.
- **Hub message coordinator** (`server/coordinator.js`) per user, agent and conversation: a persisted FIFO queue with stable message ids, idempotent admission (`client_id`), a control path that never waits for the run, never two writers, Stop halts queue draining until you resume or send again, unused guidance (`pending_steer`) comes back once as a queued message, and the queue survives a hub restart (paused until resumed). API: `POST /api/agents/{name}/messages`, `GET /queue`, `POST /queue/resume`, `DELETE /queue/{id}`; `POST …/runs/{id}/stop` now reports whether termination was confirmed.
- **Hermes native runs** (`server/hermes-runs.js`): when `GET /v1/capabilities` advertises `run_submission`, `run_events_sse`, `run_steer` and `run_stop`, chat uses `POST /v1/runs` (with `Idempotency-Key`, session reuse and cursor replay), `/steer` and `/stop`. Older Hermes keeps `/v1/chat/completions` (queue and transport-abort interrupt only). `/steer …` text is never sent through chat.
- Grok and other OpenAI-compatible agents: queue, and abort and resubmit with the stored history. MCP inbox: queue only.

### Changed

- Every chat send now goes through the coordinator, so one conversation has one writer; `POST …/chat` answers 409 while the agent is replying (clients use `/messages`).
- Web chat store: stream callbacks are bound to their stream and ignored once another chat is open; the transcript is no longer replaced from a captured snapshot; a stopped reply keeps its partial text marked *Interrupted*.

## 0.2.1-alpha

Android `versionName 0.2.1-alpha`, `versionCode 6`. Not yet published; the version is set in every package (server, web, docs, connector, OpenAPI).

### Fixed

- Web chat keeps unsent text like a messenger: per agent and session, restored after switching chats, a reload or closing the browser. Drafts are stored text-only in this browser's `localStorage`, scoped to the signed-in user, written after a short pause, cleared when you send, start a new chat or delete the session, and wiped on sign-out. Attachments in a draft stay in memory only; sign-out cancels pending uploads. A draft typed in a new chat follows it when the hub assigns the session id.
- Text-size preferences scale typography without pushing the chat composer or sidebar controls below the viewport.
- The composer shows a visible focus outline, and the history menu supports keyboard navigation (arrows, Home/End, Escape, outside dismissal, focus return).
- Pairing-code styling no longer adds letter spacing to Markdown code blocks.
- **Chats no longer end when the app or browser closes.** The hub now owns each agent run: it keeps going when the client disconnects, buffers events in a bounded replay log and lets a reconnecting client resume from the last event id. Only the Stop button stops a run (hub commit `96cc648`; the old hub test that expected a client disconnect to abort the upstream run was replaced by `server/test/runs.test.js`, which covers disconnect, resume and explicit stop). The current agent, session and in-progress run are remembered across app restarts (Android settings store, web `localStorage`).
- **Old conversations are formatted.** Hermes transcripts are normalised on the hub (tool calls folded into the assistant turn, reasoning split out, multimodal parts flattened, control tags and raw JSON hidden) and rendered with the same Markdown pipeline as live replies, with timestamps and grouping. Chats open at the bottom and load older messages as you scroll up.

### Changed

- Android: a unit test and a CI script (`scripts/check-android-assets.mjs`) now fail when the screen-takeover assets (`screen.html`, `screen.js`, noVNC) are missing; the release guide checks the built APK for them.
- `NOTICE.md` and `LICENSES/Hermes-MIT.txt` credit the Hermes command catalog.

### Added

- **History** in the chat header (web and Android; on the web it is the keyboard-navigable menu): title, time, preview, open, rename, delete, *New chat*, load more, pull-to-refresh. API-key agents (OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok Build) now keep hub-side history with a retention setting (`FOXFLEET_HISTORY_DAYS`, default 90; `PUT /api/history/settings`).
- **Hermes slash commands**: the full catalog (generated from the Hermes command registry), grouped, with args hints, and marked as *runs in the app*, *sent to the agent* or *not available remotely*. Other agent kinds never show them.
- **`foxfleet` command-line tool** (`server/bin/foxfleet`, Node, no dependencies): `doctor`, `update`, `status`, `start|stop|restart|logs`, `setup`, `user`, `invite`, `backup|restore`, `config`, `connector`, `version`, `completion`; `deploy/install.sh` installs it from a release. See [CLI reference](https://tinkerdoge.github.io/FoxFleet/reference/cli).
- Hub API: `GET /api/agents/{name}/runs`, `…/runs/{id}/events`, `POST …/runs/{id}/stop`, `GET/PUT /api/history/settings`, `GET /api/agents/{name}/commands`; paged `sessions` and `messages`.

## 0.2.0-alpha: easy connect

Android `versionName 0.2.0-alpha`, `versionCode 5`.

### Added

- **Easy onboarding for Hermes.** *Manage › Machines › Connect a machine* (web and Android) makes a 15-minute, single-use pairing code and shows a one-line `curl … | sh` command (plus PowerShell and Node-only variants), a `foxfleet://pair` magic link, a QR of the https link and a live status line (*Waiting for the machine…* → *Found 3 profiles: default, coder, research*).
- **One connector per computer.** `foxfleet-connector` pairs once, discovers Hermes profiles (`~/.hermes`, `profiles/<id>`), lets you choose them (checklist, `--all`, `--profiles a,b`), registers each as an agent and multiplexes them over one outbound WebSocket. `--install-service` for systemd (user), launchd and a Windows scheduled task, with `uninstall-service`.
- **Machines.** `GET/POST /api/machines…` (pairing create/status, redeem, list, rename, revoke, rotate); the hub keeps only a token hash; revoke removes the machine's agents. Manage › Machines lists status, profiles and last seen.
- Dashboard passwords and chat API keys of machine agents are read locally by the connector and never sent to the hub.

### Documentation and legal

- README, docs home and pages use real screenshots of the web and Android apps (rebuild with `design/tools/make-readme-images.py`); the old drawn placeholders and the placeholder funding links are gone.
- Terms of Use, User Agreement and Privacy Policy templates ship with the release (still pending legal review).

### Changed

- **Breaking (alpha):** the per-agent connector token and bootstrap prompt are gone (`connectorToken`, `bootstrap`, `connectorTokenHash`, `HUB_URL`, `FOXFLEET_TOKEN`). Connect machines instead. Hermes agents added by hand are now direct connections only.

## 0.1.0-alpha: first release

Android `versionName 0.1.0-alpha`, `versionCode 3`.

### Added

- **Hub** (Node 22, no runtime dependencies): accounts and a login gate (first-run owner setup, scrypt password hashes, invite or open registration, rotating session tokens, device list with revoke, sign out everywhere, rate limiting and lockout, CSRF/Origin checks); per-user agent registries and write-only secrets; plugin kinds for OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok and Hermes agents; an MCP inbox for bridged agents; QR pairing and invite links; `/api/media-proxy` with SSRF protection; static serving of the web app with SPA fallback, CSP and cache headers.
- **Hermes connector**: outbound-only connection from the agent's machine to the hub, HTTP and WebSocket tunnelling, so chat and screen takeover work without opening ports.
- **Screen takeover** with short-lived tickets, hand-back, a time limit and a visible red border (web) / `FLAG_SECURE` (Android).
- **Web app** (Preact + Vite + TypeScript, installable PWA): streaming chat with sanitised Markdown, reasoning blocks, tool status, image and file attach, `/` and `#` autocomplete, voice input where the browser supports it, media viewer, schema-driven agent management, screen takeover (noVNC), Admin (registration, invites, people, pairing QR), devices and security, settings, accessibility pass.
- **Android app** (`dev.foxfleet.app`, Kotlin + Compose): the same features, QR scan through the Google code scanner, `foxfleet://connect` deep links, multiple hubs.
- **Terms of Use, User Agreement and Privacy Policy** (templates) with an acceptance checkbox on the setup and join screens; the hub records the accepted version and time (`acceptedTerms`).
- **Shared design tokens** (`design/tokens.json`) generating web CSS and the Compose theme.
- **OpenAPI 3.1 contract** (`contract/openapi.json`) with a shared scenario run against the real hub and the web mock.
- **Documentation site** (VitePress, GitHub Pages), Docker and systemd deployment files, `deploy/deploy.sh` (backup, tests, restart, health check, rollback, `--dry-run`).
- **Release tooling**: release signing configuration for the Android app (keystore from environment or an untracked file), a draft release workflow, server tarball with checksums.

### Known limitations

See the roadmap (`docs/roadmap.html`) and `RELEASE_NOTES_0.1.0-alpha.md`.
