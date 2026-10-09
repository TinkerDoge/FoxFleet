# Changelog

All notable changes to Foxfleet. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/) (`0.x` is alpha: breaking changes can happen between releases; `config.json` v3 is the stable part).

## Unreleased

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
