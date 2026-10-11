# Changelog

All notable changes to Foxfleet. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/) (`0.x` is alpha: breaking changes can happen between releases; `config.json` v3 is the stable part).

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
