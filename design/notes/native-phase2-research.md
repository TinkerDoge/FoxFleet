# FoxFleet native bot agents, phase 2: Stop, interaction cards, media

Read-only research against `/home/doge/projects/FoxFleet` at `b38473c` (main) and Hermes core at
`/home/doge/.hermes/hermes-agent` `0e427d788d`. No files were edited.

**Legend.** **[F]** is a verified fact with a `file:line` citation (paths are repo-relative). **[P]** is a proposal.
Unmarked prose is reasoning that connects the two.

Short repo prefixes used below: `srv/` = `server/`, `web/` = `web/src/`,
`and/` = `android/app/src/main/java/dev/foxfleet/app/`, `plg/` = `hermes-plugin/foxfleet/`,
`hc/` = Hermes core `/home/doge/.hermes/hermes-agent/`.

---

## 0. Executive summary

- **Stop is a no-op upstream today [F].** For a bot run the app's Stop goes to `POST /runs/:id/stop`
  (`srv/bot-api.js:234`). That calls `runs.stopAndWait` (`srv/runs.js:67-76`), then `link.stop`, which here only does
  `end(st,'stopped')` (`srv/bot-api.js:158`, `147-152`). The contract says the same thing: "v1 has no way to stop the
  bot" (`contract/bot-api.md:342-343`). Typing `/stop` doesn't help either: both apps treat it as a local command
  and never send it (`web/lib/commands.ts:17` → `web/chat/ChatView.tsx:85`; `and/ui/screens/ChatScreen.kt:352`).
- **The apps already render cards and media for bots, through shapes the hub can produce without app changes [F].**
  - Web always mounts `RequestCards` (`web/chat/ChatView.tsx:210`) and answers via
    `/native/sessions/:sid/requests/:id` (`web/api/client.ts:305`).
  - Every `/api/agents/:name/...` route for a bot already lands in `bot.route()` (`srv/index.js:502-507`). So the
    hub can serve `native/.../requests`, `media` and `files` for bots inside `srv/bot-api.js` alone.
- **Exactly one app change is unavoidable [F].** Android shows cards only when `capabilities.nativeUi` is true
  (`and/MainActivity.kt:177`). Setting `nativeUi:true` for bots instead would hijack `/model` into the native model
  picker in both apps (`web/chat/Composer.tsx:98`, `and/ui/screens/ChatScreen.kt:343`, `and/MainActivity.kt:178`),
  and bots cannot serve that picker. So Android needs a one-line gate change. Web needs **zero** changes.
- **Proposal [P]: `foxfleet.bot/1.1`, negotiated by WebSocket subprotocol**, built on the reserved names `callback`,
  `callback.answer`, `card.send`, `media` and `POST`/`GET /api/bot/media`, plus two new names:
  - hub → bot `chat.stop`;
  - bot → hub `card.close`.
- **Ids and authority [P].** The hub mints every request id and media id and binds each one to
  (account, bot, chat, user). Answers are one-shot and expire. Strings from the bot never authorise anything.
- **Plugin mapping [P].** It follows Hermes' own relay adapter (`hc/gateway/relay/adapter.py:1783-2198`), which
  solves the same problem: a remote surface renders the prompt and the answer comes back by id.

---

## A. What the apps use today

### A.1 Capability flags and which code path each app takes

| Flag (hub `srv/index.js:213-222` for bots) | Bot value today | Web | Android |
|---|---|---|---|
| `nativeUi` | `false` (`srv/index.js:218`) | When true: plain send mode is `'auto'`, `/model` opens the native picker, bare commands open a choice picker (`web/chat/Composer.tsx:20,76,98-100`). Request cards are **not** gated by it (`web/chat/ChatView.tsx:210`). | Gates the **request cards** (`onAnswerRequest`, `and/MainActivity.kt:177`) and `nativeControls` (model picker, profile busy, `and/MainActivity.kt:178`). Also the composer's native flag and `/model` (`and/ui/screens/ChatScreen.kt:343`) and `sendMode` (`and/HubViewModel.kt:291`). |
| `nativeRuns` | `false` | Typed only (`web/api/types.ts:21`), no UI use (grep) | Not parsed (`and/data/HubApi.kt:650-657`) |
| `busy` | `['queue']` | Send modes and plain mode (`web/chat/Composer.tsx:20,31`). While streaming, a send goes to `submitBusy` → `POST /messages` (`web/chat/store.ts:251,267-281`). | Parsed (`and/data/HubApi.kt:656`), used at `and/ui/screens/ChatScreen.kt:343` and `and/HubViewModel.kt:291-307` |
| `images` / `files` | `false` (`srv/config.js:109`) | Attach menu and pickers (`web/chat/Composer.tsx:49,56,167-171`) | `allowImages` / `onUploadFile` (`and/MainActivity.kt:192-193`, menu `and/ui/screens/ChatScreen.kt:909-924`) |
| `media` (object) | `{...mediaInfo, agent:'none', tags:false}` (`srv/index.js:218`) | Not read per agent. Hub features only (`web/lib/hubCompat.ts:3`). | Not parsed |
| `voice` | `false` | Mic (browser speech recognition) hidden (`web/chat/Composer.tsx:181`) | n/a here |
| `reactions` | `false` | Reactions UI off (`web/chat/ChatView.tsx:93-94`) | `and/MainActivity.kt:175` |
| Queue `can_cancel` | `false` (`srv/bot-api.js:390`) | `parseQueue` (`web/api/client.ts:37`) → Cancel disabled (`web/chat/ChatView.tsx:201`) | `and/data/HubApi.kt:493` |

### A.2 (i) Approval and clarify cards: shapes, routes, events

**Hub producer (connector-native path) [F]**
- `requestView` (`srv/hermes-ui.js:41`) produces:
  - approval: `{request_id, kind:'approval', command, description}`;
  - clarify: `{request_id, kind:'clarify', questions:[{id, question, choices[], multi_select}]}`.
  - Text is cut to 2000 chars and choices to 50.
- Live: `event: foxfleet.request` with that object, and `event: foxfleet.request_closed {request_id, reason}`
  (`srv/native-facade.js:18-20`). The reason is `answered` (`hermes-ui.js:155`) or the upstream cancel reason
  (`hermes-ui.js:35`).
- Snapshot: `GET /api/agents/:name/queue?session_id=` returns `open_requests: [requestView…]`
  (`srv/native-facade.js:82`, `srv/hermes-ui.js:79,104`). For bots it is always `[]` (`srv/bot-api.js:390`).
- Answer: `POST /api/agents/:name/native/sessions/:sid/requests/:id` with body `{result}` or `{error}`
  (`srv/index.js:567`). It is one-shot: a missing or already-answered id gives `404 "That question is no longer open"`
  (`srv/hermes-ui.js:151-156`).
- Push: `reg.notify.emit({type:'approval', agent, chat, request_id, kind})` (`srv/index.js:157`).
- Agent-list `needs_input`: only for `nativeUi` agents (`srv/index.js:262`).

**Web [F]**
- `parseRequest` (`web/api/client.ts:32-35`):
  - accepts only `kind` `clarify` or `approval`;
  - `request_id` must match `^[\w.:-]{1,100}$`;
  - keeps at most 6 questions and 50 choices.
- SSE handling: `foxfleet.request` and `foxfleet.request_closed` (`web/api/client.ts:143-144`) feed
  `onRequest`/`onRequestClosed` (`web/chat/store.ts:122-123`).
- When a stream settles, `requests: []` (`web/chat/store.ts:135`). Then `syncQueue` restores them from
  `open_requests` (`web/chat/store.ts:165`).
- UI: `RequestCards` (`web/chat/RequestCards.tsx:14-43`).
  - Approval buttons send `{choice:'once'}` or `{choice:'deny'}` (`:20`).
  - Clarify sends `{answers:{[qid]: string}}`. Multi-select joins the picks with `', '`, and typed "Other" text
    wins over the picks (`:25,40`).
- `answerRequest` (`web/chat/store.ts:308-314`) needs `c.session`. A 404 just drops the card.

**Android [F]**
- `parseRequest` (`and/data/HubApi.kt:621-629`) applies the same rules as web.
- SSE: `foxfleet.request` and `foxfleet.request_closed` are handled (`and/data/HubApi.kt:556-557`).
- Queue `open_requests` (`and/data/HubApi.kt:490-494`) → `ChatState.requests` (`and/ui/chat/ChatState.kt:280`).
- UI: `RequestCard` (`and/ui/screens/NativeUi.kt:75-103`).
  - Approval: `approvalAnswer` → `{choice:'once'|'deny'}` (`:62`).
  - Clarify: `clarifyAnswers` → `{answers:{qid: text}}`, multi joined with `', '` (`:57-61`).
- Rendered only if `onAnswerRequest != null` (`and/ui/screens/ChatScreen.kt:469`), which is gated on
  `capabilities.nativeUi` (`and/MainActivity.kt:177`).
- Answer: `answerRequest` (`and/data/HubApi.kt:510-512`) → `/native/sessions/:sid/requests/:id`. A 404 drops the card
  (`and/ui/chat/ChatState.kt:289-295`).
- Push type `approval` uses a high-importance channel (`and/notify/NotifyChannels.kt:12`,
  `and/notify/NotifyModels.kt:58`).

### A.3 (ii) Stopping a running reply

- **Web [F].**
  - The Stop button shows only while `streaming` (`web/chat/Composer.tsx:182`). It, and the `/stop` local command
    (`web/lib/commands.ts:17`, `web/chat/ChatView.tsx:85`), call `stop()` (`web/chat/store.ts:99-104`).
  - `stop()` sends `POST /api/agents/:name/runs/:run/stop {}` (`web/api/client.ts:296`). It aborts the local stream
    at once, marks the reply interrupted and then runs `syncQueue`.
  - The response `{run, confirmed}` is ignored. If the hub still reports `active_run`, `syncQueue` follows it again
    (`web/chat/store.ts:166`).
- **Android [F].**
  - The Stop button (`and/ui/screens/ChatScreen.kt:963`) and `LocalCommand.Stop` (`:352`) call `onStop`
    (`and/MainActivity.kt:172`).
  - That runs `vm.stop` (`and/HubViewModel.kt:379-383`): `api.stopRun` (`and/data/HubApi.kt:477`), then
    `syncQueue`, then a local `finishRun`.
- **Hub [F].**
  - Bot runs: `runRoutes` stop → `runs.stopAndWait` (`srv/bot-api.js:234`).
  - `stopAndWait` calls `link.stop` and waits up to 15 s for `r.done`. If `link.stop` throws, or the run is not done
    in time, it returns `false` and the run keeps going (`srv/runs.js:67-76`).
  - For the bot, `link.stop` is `end(st,'stopped')` (`srv/bot-api.js:158`). The registry then pushes
    `event: foxfleet.run {state:'stopped'}` (`srv/runs.js:23`).
  - Contrast: native agents' `link.stop` calls `nat.interrupt` upstream (`srv/native-facade.js:36`).
- **Run liveness [F].** A bot run idles out 30 s after the bot last wrote, or after 5 minutes if it never wrote
  (`srv/bot-api.js:36,146`). Any bot activity, including `typing`, re-arms the timer (`srv/bot-api.js:169`).

### A.4 (iii) Showing and uploading images and files

**Agent → user [F]**
- Web, live: `parseStreaming` while streaming, otherwise `parseMedia` (`web/chat/Message.tsx:36`). Assistant text
  is always parsed for `MEDIA:` tags, regardless of capabilities.
- Web, rendering: `MediaCards`.
  - `data:image/…` loads directly.
  - An `https` image goes through `/api/media-proxy`.
  - Anything else calls `resolve(ref)` (`web/chat/MediaCards.tsx:22-47`), which is
    `POST /api/agents/:name/media {ref}` → `{url, kind, name}`. The `url` must start with `/api/media/`
    (`web/api/client.ts:281-285`).
- Android: **every** ref, including https, goes through `resolve` → `POST /media`. The url must start with
  `/api/media/` and is prefixed with `baseUrl` (`and/data/HubApi.kt:457-463`,
  `and/ui/components/MediaCards.kt:63-82,102-129`). A 404 is retried 3 times (`MediaCards.kt:88-98`).
- Tag grammar: a ref must start with `~/`, `/`, `X:\` or `http(s)://` and end in a known extension
  (`srv/media-tags.js:14-16`). Twins: `web/lib/mediaTags.ts`, `and/ui/chat/MediaTags.kt`. Only extensions in
  `DELIVERABLE` are served (`srv/media-tags.js:6-11`, `srv/media.js:35`).
- Hub serving:
  - `media.resolve` mints an HMAC token bound to the account, valid 15 min (`srv/media.js:31-38`).
  - `GET /api/media/:token` (`srv/index.js:424`) → `serve` loads from a URL or from `connectors.fetchMedia`, keeps
    up to 25 MiB in memory and supports ranges (`srv/media.js:53-73`).
  - For bots, `POST /media` falls into `bot.route`, which answers 404 (`srv/index.js:502-507`,
    `srv/bot-api.js:376-400`).

**User → agent [F]**
- Images:
  - The app downscales them and sends `data:image/...;base64` parts in `messages[].content`
    (`web/lib/chat.ts:18-27`, `and/data/ChatPayload.kt:13-34`) to `POST /chat` or `POST /messages`.
  - For bots, `chatBody` refuses non-text parts with `400 unsupported` (`srv/bot-api.js:198`).
  - For native agents the hub forwards them (`srv/index.js:112,598-605`).
- Files:
  - `POST /api/agents/:name/files?name=&type=` with an octet-stream body, at most 90 MiB (`srv/index.js:47,624-651`).
    The response is `{name, path, size, mime}`.
  - Web: `uploadFile` (`web/api/client.ts:317-331`). Android: `and/data/HubApi.kt:322-345`.
  - Both apps append `[Attached file: <path> (<size>)]` to the text (`web/lib/files.ts:11-12`,
    `and/data/Files.kt:11-14`).
  - The chip shows `path.split('/').pop()` on web (`web/chat/Message.tsx:131`) and
    `path.substringAfterLast('/').substringAfter('-')` on Android (`and/ui/screens/ChatScreen.kt:556`).
  - Only `/api/agents/:name/files` is exempt from the "mutations must be JSON" rule (`srv/index.js:331-333`).
- User images in history: `messages[].images: [string]`.
  - Web uses each entry as `img src`, so a relative URL works (`web/lib/chat.ts:10`).
  - Android gives it to Coil as is (`and/data/HubApi.kt:291-294`, `and/ui/screens/ChatScreen.kt:547,577`). Per the
    comment on `ChatImage` (`and/ui/components/ChatImage.kt:38-40`) the model is a File, a `data:` URL or an
    `https` URL, so a relative `/api/...` URL would not load on Android.
  - The direct Hermes transcript keeps only `https:` or `data:image/` URLs under 400 000 chars (`srv/transcript.js:35`).
  - Bot transcripts return `{id, role, content, ts, edited?}` only (`srv/bot-store.js:248-251`).

### A.5 Gaps already present for bots

- **[F]** Android's SSE pump has no `foxfleet.replace` handler (`and/data/HubApi.kt:553-576`; grep finds none).
  Web has one (`web/api/client.ts:146`). The hub emits `foxfleet.replace` whenever a bot edit is not a pure append
  (`srv/bot-api.js:171-176`). Android therefore shows stale text until the transcript reloads.
- **[F]** Bot user-message images are refused, and bot transcripts carry no `images` (see A.4).

---

## B. Hermes adapter hooks and resolvers (reference)

### B.1 Exec approval

- **[F] Hook.**
  - The runner calls `send_exec_approval` (`hc/gateway/platforms/base.py:2891-2907`). It builds an
    `ExecApprovalPrompt{chat_id, session_key, text, actions[(label, choice, style)], command, description,
    smart_denied, metadata}` (`base.py:1679-1697`).
  - Choices are `once`, `session`, `always` and `deny`. A smart deny drops `session` and `always`
    (`base.py:2872-2883`).
  - Adapters override `_send_exec_approval_prompt` (`base.py:2909-2911`). `supports_exec_approval_buttons()` turns
    true when that override exists (`base.py:2885-2889`); the runner probes it at `hc/gateway/run_turn_runner.py:54-56`.
- **[F] Resolver.** `tools.approval.resolve_gateway_approval(session_key, choice, resolve_all=False, reason=None,
  request_id=None)` returns how many approvals it resolved (`hc/tools/approval.py:139-173`).
  - Without `request_id` it resolves the **oldest pending (FIFO)** entry.
  - Every pending entry carries `data["request_id"]`, a uuid hex set before the notify callback runs
    (`hc/tools/approval_gateway_wait.py:32`, enqueue before notify at `:160-169` area).
  - Helpers: `list_gateway_approvals` (`approval.py:193-196`), `register_gateway_settle(session_key, request_id,
    settle)` (`:199-207`, runs once when the wait ends by any path), `withdraw_gateway_approval` (`:176-190`).
- **[F] Telegram reference.**
  - `_send_exec_approval_prompt` sends a keyboard with `ea:<choice>:<n>` and maps `n` to `session_key`
    (`hc/plugins/platforms/telegram/adapter.py:4231-4246`).
  - The callback (`:4718-4760`) checks authorisation and claims the state once (`_claim_callback_state`,
    `:4709-4716`). It then calls `resolve_gateway_approval(session_key, choice)` (FIFO, no request id). If the count
    is 0 it renders "expired", then resumes typing.
- **[F] Relay reference.** Options are `{id: choice, label, style}`. A prompt id is minted per process with an
  owner nonce (`hc/gateway/relay/adapter.py:1931-1958,2039-2049`), and the answer resolves via
  `_resolve_exec_approval` (`:2157-2167`).

### B.2 Slash-command confirm

- **[F] Hook.** `send_slash_confirm(chat_id, title, message, session_key, confirm_id, metadata)`
  (`base.py:2927-2935`). The choices are `once`, `always` and `cancel`. A failure falls back to the text
  `/approve`, `/always` and `/cancel`.
- **[F] Resolver.** The base docstring names `GatewayRunner._resolve_slash_confirm`. Both real adapters call
  `await tools.slash_confirm.resolve(session_key, confirm_id, choice)` instead (`telegram/adapter.py:4782-4783`,
  `relay/adapter.py:2169-2178`).
  - That function pops before it runs, so a double tap cannot run the handler twice. It returns `None` when the
    confirm is stale or superseded (`hc/tools/slash_confirm.py:64-80`).
  - Typed aliases are handled at `hc/gateway/run_inbound.py:452-458`.

### B.3 Clarify (multi-select, "Other", retire)

- **[F] Hook.** `send_clarify(chat_id, question, choices, clarify_id, session_key, metadata)` (`base.py:2937-2965`).
  - It asks **one question per call**.
  - The multi-select flag lives on the pending entry: `clarify_gateway._entries[clarify_id].multi_select`
    (`base.py:2949-2955`, `hc/tools/clarify_gateway.py:19-29,49-58`).
  - Open-ended entries (no choices) start with `awaiting_text=True`.
  - Call sites: `hc/gateway/run_turn_runner.py:1374-1450`. If a native card fails, the runner retries with the base
    text prompt (`hc/gateway/run_turn_runner_clarify_delivery.py:28-39`).
- **[F] Resolvers.**
  - `resolve_gateway_clarify(clarify_id, response)` returns `False` if the clarify is already resolved or unknown
    (`clarify_gateway.py:93-101`).
  - `mark_awaiting_text(clarify_id)` is the "Other" path (`:231-237`).
  - The answer value for multi-select is a JSON array string of labels, decoded on the tool side
    (`_coerce_multi_select_text`, `:193-210`; doc at `:165-176`). The skip/cancel sentinels are at `:39-45`.
- **[F] Retire.** An adapter may define `async retire_clarify_card(clarify_id, notice)` (doc at `base.py:2945-2947`).
  The gateway calls it:
  - on timeout, `/new` or run end (`run_turn_runner.py:1430-1438`);
  - after a typed answer (`run_inbound.py:420-425`);
  - after prose cancels the prompt (`run_inbound.py:438-450`).
  Only Slack implements it (`hc/plugins/platforms/slack/adapter.py:5657`). Telegram does not.
- **[F] Telegram reference.**
  - `send_clarify` sends numbered buttons `cl:<id>:<idx>` plus `cl:<id>:other` (`telegram/adapter.py:4266-4283`).
  - The callback (`:4809-4874`) treats "other" as `mark_awaiting_text`, so the next typed message answers it.
  - A numeric tap resolves `entry.choices[idx]` through `resolve_gateway_clarify`. If the clarify is gone it reports
    "expired".
  - Relay works the same way with positional ids `c0..cN`/`other` (`relay/adapter.py:2074-2108,2180-2198`).

### B.4 /stop interruption

- **[F]** `/stop` is a gateway command with `busy_policy="interrupt_then_dispatch"` (`hc/hermes_cli/commands.py:124-125`).
  - While busy: `_busy_stop_command` → `_interrupt_and_clear_session(..., _INTERRUPT_REASON_STOP)`
    (`hc/gateway/run_busy.py:1018-1025`).
  - Otherwise: `_handle_stop_command` (`hc/gateway/slash_commands.py:420-470`) interrupts runs in the same chat and,
    when idle, also background delegations. It returns an `EphemeralReply`.
  - The adapter-level primitive is `interrupt_session_activity` (`base.py:3469-3473`) over `_active_sessions`
    (`base.py:1986`).
- **[F]** In the FoxFleet plugin, inbound text goes through `handle_message`, so a typed `/stop` would work. The
  plugin already treats interrupt-then-dispatch commands specially (`plg/adapter.py:767-776`). The apps never send
  that text, though (A.3).

### B.5 Outbound media

- **[F] Hooks and defaults.**
  - `send_image(url)` falls back to sending the URL as text (`base.py:3036-3041`).
  - `send_animation` goes to `send_image` (`:3043-3049`).
  - `send_multiple_images` sends each image on its own: `file://` → `send_image_file` (`:3000-3034`).
  - `send_voice` (`:3083-3089`), `send_video` (`:3207-3212`), `send_document` (`:3214-3219`) and `send_image_file`
    (`:3246-3251`) default to a friendly failure notice that **never echoes the local path**
    (`_send_media_fallback_notice`, `:3091-3101`).
  - A failed upload produces a user-visible notice (`_notify_media_delivery_failure`, `:3221-3244`).
- **[F] Dispatch.** `MEDIA:` tags and bare local files are routed by type (`_deliver_media_attachments`,
  `base.py:4307-4358`):
  - images → batched as `file://` via `send_multiple_images`;
  - audio → `send_voice`;
  - video → `send_video`;
  - everything else → `send_document`.
  Paths are checked first by `validate_media_delivery_path` (`base.py:1165-1212`; strict mode, allow-dirs, symlinks
  resolved) and `filter_media_delivery_paths` (`:3259-3270`).
- **[F] Relay reference.** A local path is uploaded to the connector's media endpoint first, because "the connector
  cannot reach our filesystem". The resulting URL is then sent in a `send_media` op. If that lane is unavailable it
  falls back to the base behaviour (`relay/adapter.py:1783-1927`).
- **[F] Telegram reference.** `send_voice` (`telegram/adapter.py:5173`), `send_image_file` (`:5295`),
  `send_document` (`:5356`), `send_video` (`:5368`), `send_image` (`:5402`).
- **[F] FoxFleet plugin today.**
  - Text only. `PLATFORM_HINT` tells the model it cannot send images or files (`plg/adapter.py:124-129`).
  - No media override exists, so the base notices apply.

### B.6 Inbound media

- **[F]** `MessageEvent` fields (`hc/gateway/platforms/event.py`):
  - `media_urls: list[str]`: **local file paths** (`:67-68`);
  - `media_types: list[str]`: MIME types (`:69`);
  - `media_text_inlined` (`:71`);
  - `message_type` (`MessageType`, `:24`);
  - `prompt_response` (relay only, `:82-84`).
- **[F]** The cache helper `cache_media_bytes(_async)(data, filename, mime_type, default_kind)` returns
  `CachedMedia{path, media_type, kind, display_name}` (`base.py:1578-1622`). Documents are cached as
  `doc_<uuid>_<name>` under the cache dir (`:1526-1539`). The inbound size cap is `get_inbound_media_max_bytes()`,
  default 128 MiB (`base.py:549-556`).
- **[F] Telegram pattern.** `_attach_cached` appends `cached.path` and `cached.media_type`, and sets
  `message_type` from the first attachment (`telegram/adapter.py:6261-6268`).
- **[F] Gateway handling.**
  - `rehome_inbound_media` moves cached files into the routed profile's cache (`hc/gateway/run_inbound_media.py:15-30`).
  - `_classify_inbound_media` splits into image, voice, audio and video (`run_inbound.py:1447-1467`).
  - Documents get a context note (`run_inbound.py:1564-1590`).
- **[F] FoxFleet plugin today.** `_build_event` sets `MessageType.TEXT` and no media (`plg/adapter.py:812-820`).
  `parse_message_new` requires non-empty `text` (`plg/protocol.py:172`).

### B.7 Plugin-side compatibility facts that constrain 1.1

- **[F]** The plugin offers only `foxfleet.bot.v1` and checks the echo (`plg/adapter.py:471,483`). `parse_hello`
  needs `protocol == "foxfleet.bot/1"` **exactly** (`plg/protocol.py:92-96`). The hub echoes one subprotocol
  (`srv/bot-ws.js:15,29`).
- **[F]** In an existing plugin:
  - an unknown frame **with** `event_id` is skipped and acked in order (`plg/adapter.py:628-632`);
  - an unknown frame **without** one is ignored (`:633-634`);
  - `replay.gap` is fatal (`:618-620`).
- **[F]** The hub classifies the reserved names as `unsupported` (`srv/bot-protocol.js:8,39,115`).

---

## C. Proposal: `foxfleet.bot/1.1`

### C.0 Principles

1. **Hub-minted ids are the only authority.** Request ids (`fr_` + 22 base64url) and media ids (`fbm_` + 24 hex)
   are random and minted by the hub. Each is stored with `{scope, botId, chat_id, user_id, kind, state, expires_at}`
   and looked up only inside the bot's own store, the same rule as for chat and message ids today
   (`contract/bot-api.md:106-107`).
2. **Opaque bot strings.** The bot's `card_key` is a correlation string for the bot only. The hub echoes it and never
   acts on it, consistent with the existing rule "Callback strings… authorise nobody" (`contract/bot-api.md:39`).
3. **Reuse the user-side shapes.**
   - cards are `foxfleet.request`, `foxfleet.request_closed`, `open_requests` and the `/native/.../requests/:id`
     route;
   - media uses `MEDIA:` refs resolved by `POST /media` to `/api/media/…`, plus `[Attached file: …]` and `/files`;
   - Stop is the existing `/runs/:id/stop`.
4. **One-shot answers.** The state change and the durable event are written in a single atomic store write, the same
   pattern as messages (`srv/bot-store.js:17-56`).

### C.1 Negotiation

- **[P]** A 1.1 bot offers `Sec-WebSocket-Protocol: foxfleet.bot.v1.1, foxfleet.bot.v1`. The hub echoes the
  highest version it supports.
  - On `v1.1`: `hello.protocol = "foxfleet.bot/1.1"` and
    `hello.features = ["stop","cards","media"]`.
  - New `hello.limits`: `max_media_bytes`, `max_media_per_message`, `max_open_requests`.
- **[P]** A 1.0 bot (today's plugin) gets exactly today's `hello`, so `plg/protocol.py:95` is unaffected. The hub
  persists the last negotiated protocol per bot (`proto` in the bot store).
- **[P]** Capabilities come from that: `images`, `files`, `media.agent:'bot'` and `media.tags:true` are on only when
  the last connection was 1.1. Request cards and Stop are offered only while a 1.1 socket is live.

### C.2 Stop

| | Shape |
|---|---|
| hub → bot (**new**, transient, no `event_id`, never replayed) | `{"t":"chat.stop","stop_id":"fs_…","chat_id":"fc_…","user":{"id","name"},"date":ms,"expires_at":ms}` |
| bot → hub (**reserved `callback.answer`**) | `{"t":"callback.answer","id":"…","callback_id":"fs_…","outcome":"stopped"\|"idle"\|"refused"\|"expired"}` → `res {}` |

- **[P] Hub.** Replace `st.link.stop` (`srv/bot-api.js:158`) with:
  - If no 1.1 socket is connected: throw. `stopAndWait` then returns `confirmed:false` and the run stays truthful.
  - Otherwise send `chat.stop`, with a 10 s expiry, and wait for `callback.answer`:
    - `stopped` or `idle` → `end(st,'stopped')`;
    - `refused`, `expired` or a timeout → throw.
  - The existing `runs.stopAndWait` contract (`srv/runs.js:62-76`) then reports the truth unchanged.
- **[P] Rules.**
  - Only sent for a chat that has a live run.
  - At most one stop is outstanding per chat; duplicate POSTs join it.
  - The plugin answers `expired` when `now > expires_at`.
  - Because the frame is transient, a reconnect can never deliver a stale stop that kills a later turn.
- **[P] Plugin.**
  1. Check that the user is allowed (the same allowlist as message admission).
  2. Build `MessageEvent(text="/stop", source=build_source(chat_id=…, user_id=user.id, chat_type="dm"),
     reply_expected=False, metadata={"foxfleet_stop_id": …})`.
  3. `await self.handle_message(event)`. This reuses Hermes' own `/stop` path (B.4), including authorisation and
     session-key derivation, with no core edits.
  4. Answer `stopped` if `_active_sessions` had the session key before dispatch, otherwise `idle`.
  - Optionally suppress the `EphemeralReply` ("Stopped") through a contextvar, like the existing `_notice_send`
    (`plg/adapter.py:329,771`).

### C.3 Interaction cards

| Direction | Frame | Fields (limits) |
|---|---|---|
| bot → hub (**reserved `card.send`**) | `{"t":"card.send","id","chat_id","card_key","kind","ttl_ms","instance","idempotency_key"?, …}` | `kind` ∈ `approval` \| `confirm` \| `clarify`.<br>**approval / confirm:** `command` ≤ 2000 chars, `description` ≤ 2000, `choices` ⊆ (approval) `once session always deny` or (confirm) `once always cancel`.<br>**clarify:** `questions`: 1–6 of `{id: ^[A-Za-z0-9_-]{1,32}$, question ≤ 2000, choices ≤ 50 × ≤ 300 chars, multi_select: bool}`.<br>`card_key` `^[A-Za-z0-9._:-]{1,64}$`. `ttl_ms` 1 000–3 600 000. `instance` `^[A-Za-z0-9]{6,32}$` (plugin process nonce).<br>→ `res {request_id, expires_at}` |
| bot → hub (**new `card.close`**) | `{"t":"card.close","id","request_id","reason"}` or `{"t":"card.close","id","all_except_instance":"<nonce>"}` | `reason` ∈ `expired` \| `answered` \| `cancelled`. Idempotent. → `res {closed: n}` |
| hub → bot (**reserved `callback`**, durable: `event_id`, at-least-once, cumulative ack like `message.new`) | `{"t":"callback","event_id","callback_id":"fk_…","request_id","card_key","chat_id","chat_type":"dm","user":{"id","name"},"kind","value","date"}` | `value`: `{choice}` (approval/confirm; the hub maps the app's `deny` → `cancel` for `confirm`) or `{answers:{qid: string ≤ 4096 B}}` |
| bot → hub (**reserved `callback.answer`**) | `{"t":"callback.answer","id","callback_id","outcome","notice"?}` | `outcome` ∈ `resolved` \| `expired` \| `refused`. `notice` ≤ 500 chars, optional. |

**[P] Hub mapping onto the existing user-side shapes (no app protocol change)**

- **Store.** `card.send` validates the chat in the bot's store, the per-chat cap (8 open) and the per-bot cap (64).
  It writes `requests[request_id] = {chat_id, user_id, kind, card_key, choices, question ids, instance, state:'open',
  expires_at}`, using the same idempotency machinery as `message.send` (`contract/bot-api.md:286-294`).
- **`user_id`.** The user is the sender of the chat's newest user message. A bot chat lives in one account's
  registry, so this is the account user (`contract/bot-api.md:43-46`; `srv/bot-store.js:194`).
- **Live event.** Emit `event: foxfleet.request` with the `requestView` shape (`srv/hermes-ui.js:41`):
  - `approval` and `confirm` both go out as app `kind:'approval'` with `{command, description}`. For a confirm,
    `command` = title and `description` = message.
  - `clarify` goes out as `kind:'clarify'` with `{questions:[{id, question, choices, multi_select}]}`.
  - If the chat has no live run, open one, as a `send` would (`srv/bot-api.js:154-167`).
- **Run liveness.** While a chat has open requests the run's idle timer is paused (change `arm`,
  `srv/bot-api.js:146`). Otherwise a 30 s idle would end the run under an approval that is waiting.
- **Queue.** `GET /queue` returns `open_requests` with the open, unexpired requests of that chat in requestView
  shape. This replaces `[]` at `srv/bot-api.js:390`, so both apps restore cards after a reload or a run end
  (`web/chat/store.ts:165`, `and/ui/chat/ChatState.kt:280`).
- **Push and agent list.** Call `reg.notify.emit({type:'approval', agent, chat, request_id, kind})`, the same as
  `srv/index.js:157`. Set `needs_input` from the bot's open-request count (`srv/index.js:262`).
- **Answer route (new, inside `bot.route`).** `POST /api/agents/:name/native/sessions/:chat_id/requests/:request_id
  {result}`, the same path the apps already call. It checks, in order:
  1. the request exists in **this bot's** store; otherwise 404;
  2. `request.chat_id === :chat_id`; otherwise 404;
  3. `request.user_id === c.user.id`; otherwise 404, the same answer, never 403;
  4. `state==='open'` and `now<expires_at`; otherwise 404 `That question is no longer open`;
  5. the result shape: `choice` is in the stored choices (app `deny` is mapped to `cancel` for confirm). For clarify,
     `answers` keys are exactly the stored question ids and each value is a string with no NUL, at most 4096 bytes.
     Otherwise 400.
  6. Rate limit: the per-bot bucket, plus a per-user limit.
  - Then, in **one** store write: `state='answered'`, `answered_by`, `answered_at`, and append the durable `callback`
    event. Then `pushTo(bot)`.
  - Emit `foxfleet.request_closed {request_id, reason:'answered'}`.
  - If a 1.1 socket is live, wait up to 8 s for `callback.answer`:
    - `resolved` → `200 {ok:true}`;
    - `expired` or `refused` → `404` (both apps then drop the card, `web/chat/store.ts:313`,
      `and/ui/chat/ChatState.kt:293`);
    - timeout or offline → `202 {ok:true, pending:true}`. Any 2xx drops the card.
- **Expiry.** A sweep on read and on a timer closes overdue requests and emits `request_closed` with reason
  `expired`. `card.close` emits `request_closed` with the given reason.
- **Restarts.** On each (re)connect the plugin sends `card.close {all_except_instance}`. After a Hermes restart the
  in-memory waiters are gone, so every card from an old instance closes at once.
- **One-shot and replay.**
  - A second POST gets 404 because the state is no longer `open`.
  - A replayed `callback` event is deduplicated by `callback_id`/`event_id` in the plugin, and every Hermes resolver
    is itself one-shot (B.1–B.3).
  - Cards are never part of the transcript. The plugin may post a normal `message.send` notice, e.g. "✓ Allowed once".

**[P] Plugin mapping onto Hermes hooks**

| Hermes hook | Plugin behaviour |
|---|---|
| `_send_exec_approval_prompt(prompt)` (override; this turns on `supports_exec_approval_buttons`) | `card.send kind=approval choices=prompt.choices command description`. Remember `card_key → {session_key, hermes_request_id}`, where `hermes_request_id` is the newest `list_gateway_approvals(session_key)` entry whose `command` matches (B.1). Call `register_gateway_settle(session_key, rid, settle)` so the card closes when `/approve` is typed or the wait times out. On `callback`: `resolve_gateway_approval(session_key, choice, request_id=rid)`, **targeted, not FIFO**, so a replay can never approve a later prompt. Then `callback.answer` with `resolved` if the count > 0, else `expired`, then `resume_typing_for_chat`. If `card.send` fails, return `SendResult(success=False)` so the runner's text fallback runs. |
| `send_slash_confirm(...)` | `card.send kind=confirm choices=[once,always,cancel]`. On `callback`: `await tools.slash_confirm.resolve(session_key, confirm_id, choice)`. `None` → `expired`. A returned text is sent as a normal message, as Telegram does at `telegram/adapter.py:4783-4805`. |
| `send_clarify(...)` | Read `multi_select` from `clarify_gateway._entries[clarify_id]` (as at `base.py:2950-2955`). `card.send kind=clarify questions=[{id:"q0", question, choices, multi_select}]`. Open-ended (no choices): send a card with zero choices; the apps show a text field (`web/chat/RequestCards.tsx:37`, `and/ui/screens/NativeUi.kt:97`). On `callback` with text `t`:<br>• no choices → `resolve_gateway_clarify(id, t)`;<br>• single choice, `t` equals a choice → that label;<br>• multi-select, `t.split(", ")` all equal choices → `json.dumps(labels)`;<br>• otherwise ("Other") → `mark_awaiting_text(id)` then `resolve_gateway_clarify(id, t)`;<br>• empty → `SKIPPED` semantics. |
| `retire_clarify_card(clarify_id, notice)` (new method) | `card.close reason=expired` (or `answered` after a typed answer). The gateway calls it on all three no-click paths (B.3). |
| Card defence in depth | Before resolving, check that the callback user is allowed **and** equals the user the card was raised for (the user of the card's chat), as Telegram's `_callback_authorized` does (`telegram/adapter.py:4709-4716`). |

### C.4 Media

**HTTP routes (reserved names) [P]**

- **`POST /api/bot/media`** (`Authorization: Bot …`, exact path, no query string).
  - Headers: `Content-Type: <mime>`, `Content-Length` (required), `X-Foxfleet-Chat: fc_…`,
    `X-Foxfleet-Name: <url-encoded name>`, optional `X-Foxfleet-Kind: image|audio|voice|video|file`.
  - The hub streams to `<account dir>/bot/<botId>.media/<fbm_id>` (mode 0600, written to a temp file then renamed),
    computing sha256 and sniffing magic bytes.
  - Response: `{media_id, kind, mime, name, size, sha256, expires_at}`.
  - An upload that no message references expires after 1 h.
  - Cap: `hello.limits.max_media_bytes`, default **25 MiB**, the same as `srv/media.js:14`.
  - Only these types are accepted: `DELIVERABLE` (`srv/media-tags.js:11`), with the extension forced to match the
    sniffed MIME class. `svg`, `html` and executables are refused.
  - Must be added to the JSON-only exemption (`srv/index.js:331-333`) and must **not** consume the per-IP auth
    throttle on every call (open blocker in `design/notes/native-release-gates.md`).
- **`GET /api/bot/media/:id`** (Bot auth). Serves bytes only for media owned by this bot: user uploads attached to
  one of its chats, or its own uploads. Supports `Range`, sends `Cache-Control: no-store` and
  `Content-Type: application/octet-stream` with an `X-Foxfleet-Mime` header.

**Frames [P]**

- `message.send`: the reserved field `media: [media_id…]`, 1–10 entries. `text` becomes optional when `media` is
  non-empty. Each id must be an unexpired upload by this bot for the **same** chat; otherwise `not_found`.
  Idempotency is unchanged.
- `message.new` (only on 1.1 sockets): `media: [{id, kind, mime, name, size}]`. `text` may be `""` when `media` is
  non-empty, and has the `[Attached file: …]` marker lines removed.
- For a 1.0 socket, `eventFrame` (`srv/bot-api.js:183`) renders each attachment as a text line
  `[Attachment: <name> — this bot cannot receive files]`, so an old plugin never gets empty text
  (`plg/protocol.py:172`).

**Hub mapping onto the user-side shapes (no app protocol change) [P]**

- **Agent → user.**
  - The store keeps `message.media=[ids]`.
  - The transcript `content`, and the live delta in `botActivity` (`srv/bot-api.js:170`), is
    `text + "\n\n" + "MEDIA:/bot-media/<fbm_id>/<safe-name.ext>"` lines, each ending with a newline, plus
    `[[audio_as_voice]]` if any upload was `voice`.
  - The ref starts with `/`, so all three tag parsers accept it (`srv/media-tags.js:14`). It is a hub namespace, not a
    filesystem path.
  - Edits keep the media lines: compose on read instead of storing the composed text.
- **New `POST /api/agents/:name/media {ref}` for bots** (inside `bot.route`). Parse `/bot-media/<id>/…`, look it up
  in this bot's store and require it to be attached to a message in one of its chats. Return
  `{url:'/api/media/<token>', kind, name, expires}`. The `/api/media/` prefix is required by both apps
  (`web/api/client.ts:283`, `and/data/HubApi.kt:460`).
  - Extend `mediaHub`: the token payload gets `b:{bot, id}` (`srv/media.js:36`), and `load`/`serve` get a
    disk-streaming branch with range support (`srv/media.js:53-73`). Do not buffer up to 25 MiB in the cache.
  - Keep the account binding at `srv/media.js:43`.
  - Unknown refs and refs from other bots get the same `404`.
- **User → agent, images.** In the bot `chatBody` (`srv/bot-api.js:193-203`):
  - accept up to 4 `image_url` parts with the strict `userImages` regex (`srv/index.js:112`) when the bot is 1.1;
  - decode them to blobs, as user uploads bound to (bot, chat, user);
  - keep `[image]` placeholders out of the text.
  - The transcript returns `images: ["data:image/…;base64,…"]`, re-encoded from the blob, **only** when the blob is
    at most 384 KiB; larger images show `[image]`, matching `srv/transcript.js:35`. `data:` works on both apps
    without change (A.4).
- **User → agent, files (new `POST /api/agents/:name/files` for bots).**
  - Stream to a blob, at most 90 MiB (`srv/index.js:47`), and record it as a pending upload
    `{owner user, bot, expires 24 h}`.
  - Return `{name, path:"bot-upload/<hexid>/<hexid>-<safe name>", size, mime}`. The web chip then shows
    `<hexid>-<name>` (same style as today's `<ts36>-<name>`) and the Android chip shows `<name>`
    (`and/ui/screens/ChatScreen.kt:556`). No local path ever reaches the app.
  - In `chatBody`, each `[Attached file: bot-upload/… (size)]` line must name an upload owned by `c.user` for this
    bot, not yet attached to another message; otherwise `400 "That attachment is not available"`.
  - The transcript keeps the original text, so chips still render. The event carries `media` and the stripped text.
- **Retention.** Blobs are deleted with their message (`srv/bot-store.js` prune), chat, agent or account. Add a
  per-bot byte quota (e.g. 1 GiB, configurable via `botOptions`).

**Plugin mapping [P]**

- **Outbound.**
  - Override `send_image_file`, `send_document`, `send_voice`, `send_video`, `send_animation` and
    `send_multiple_images` (bundle into one `message.send`): read the already-validated local path (B.5),
    `POST /api/bot/media`, then `message.send{media, text: caption}`.
  - `send_image(url)`: download with Hermes' `cache_image_from_url` (`base.py:723`), then upload. The hub never
    fetches bot-supplied URLs, so it gains no SSRF surface.
  - Over the size cap or on an error: return `SendResult(success=False)` and the base notice path applies
    (`base.py:3221-3244`).
  - Update `PLATFORM_HINT` (`plg/adapter.py:124-129`).
- **Inbound.**
  - In `_admit` before `_build_event` (`plg/adapter.py:724-736,812-820`): for each `media` entry,
    `GET /api/bot/media/:id` (bounded by `get_inbound_media_max_bytes()`), then `cache_media_bytes_async`
    (`base.py:1610`).
  - Append `path` and `media_type`, and set `message_type` from the first attachment's kind (Telegram pattern, B.6).
  - If a download fails: don't ack (redeliver). After N attempts, admit with a text note instead.
  - Never forward hub ids or hub URLs as paths.

### C.5 Summary of the contract delta

- **Subprotocol:** `foxfleet.bot.v1.1`; `hello.protocol "foxfleet.bot/1.1"`; `hello.features`; new `limits` keys.
- **Hub → bot:** `callback` (durable, reserved) and `chat.stop` (transient, **new**).
- **Bot → hub:**
  - `card.send` (reserved);
  - `callback.answer` (reserved, answers both `callback` and `chat.stop`);
  - `card.close` (**new**);
  - `message.send.media` (reserved field).
- **HTTP:** `POST /api/bot/media`, `GET /api/bot/media/:id` (reserved).
- **Error codes:** add `expired` (a card or upload past its TTL) and `quota_exceeded`.
- **Still reserved and unused:** `message.edited`, `message.deleted`, `reaction`, `replay.gap`, `chat.member`,
  `message.react`, `media.upload` (bytes go over HTTP, not WS frames, because of the 1 MiB frame cap,
  `srv/bot-protocol.js:4`), `chat.get`, `chat.cancel`, `buttons`, `keyboard`, `card` (cards are separate requests,
  not message fields), `thread_id`, `group_id`, `parse_mode`, `silent`, `reactions`.
- **HTTP `rpc`:** stays limited to send/edit/delete/typing (`srv/bot-protocol.js:21`). `message.send.media` should
  be allowed there for cron delivery of files.

---

## D. Unavoidable app changes

### Web: none required

All three features ride routes and events web already handles:
- `RequestCards`, which is ungated (`web/chat/ChatView.tsx:210`);
- `/native/.../requests` (`web/api/client.ts:305`);
- `POST /media` → `/api/media/` (`web/api/client.ts:281-285`);
- `/files` and markers (`web/api/client.ts:317-331`, `web/lib/files.ts:11-12`);
- `images:true`/`files:true` from the hub (`web/chat/Composer.tsx:49,56,167-171`);
- Stop (`web/chat/store.ts:99-104`).

Optional: `web/chat/RequestCards.tsx:25`. Send `picks:{qid:[index…]}` alongside `answers` so multi-select is not
ambiguous when a label contains `", "`. This is additive; the hub would prefer `picks` when present.

### Android: one required, one strongly recommended, one optional

1. **Required.** `and/MainActivity.kt:177`: change
   `onAnswerRequest = if (agent.capabilities.nativeUi) {…} else null` so it is passed unconditionally (cards exist
   only when the hub sends them), or `nativeUi || bot`. The `bot` option also needs `bot` parsed in
   `and/data/HubApi.kt:650-657` and `and/data/Models.kt:4-20`. Leave `nativeControls` (`:178`) gated, which keeps
   `/model` going to Hermes as text.
   - Without this change bot cards never render on Android (`and/ui/screens/ChatScreen.kt:469`).
   - The alternative, hub-side `nativeUi:true`, would route `/model` to the native picker on web and Android
     (`web/chat/Composer.tsx:98`, `and/ui/screens/ChatScreen.kt:343`), and bots cannot serve it.
   - Needs a new signed APK (release gate).
2. **Strongly recommended.** `and/data/HubApi.kt:553-560`: add
   `e.event == "foxfleet.replace" -> { …onReplace(text) }`, plus an `onReplace` in `StreamCallbacks` (`:377-384`)
   and `ChatState`.
   - Bot replies stream as send-then-edit (`plg/adapter.py:957-1005`). The hub emits `foxfleet.replace` for any edit
     that is not a pure append (`srv/bot-api.js:171-176`).
   - Android shows stale text until a reload. This is not needed for this phase's features, but it is visible on
     every bot reply.
3. **Optional.** `and/data/HubApi.kt:291`: prefix relative `/api/media/…` image URLs with `store.baseUrl`. Only needed
   if the hub sends signed URLs instead of `data:` for user images (C.4 avoids this).

---

## E. Risks and open questions

1. **Approval targeting [verify].**
   - The plan is to take `hermes_request_id` from the newest `list_gateway_approvals(session_key)` entry with a
     matching `command`, inside `_send_exec_approval_prompt`. Two identical concurrent prompts are coalesced into
     one leader (`hc/tools/approval_gateway_wait.py:133-160`), which keeps this safe.
   - Still to confirm: the prompt is scheduled asynchronously, so check it cannot race a resolution.
   - Fallback: FIFO, as Telegram does, which is weaker against a replayed tap.
2. **Clarify multi-select encoding.** The apps join picks with `", "`. A label that itself contains a comma makes
   the mapping ambiguous; the plugin then treats the answer as "Other" free text. See the optional web change in D.
   Hermes asks one question per card (`base.py:2937`); the apps allow up to 6.
3. **Choice coverage.** The app cards offer only `once` and `deny` (`web/chat/RequestCards.tsx:20`,
   `and/ui/screens/NativeUi.kt:62`). `session` and `always` (approval), and `always` (confirm), are unreachable from
   the app. The hub accepts them for future clients.
4. **Hermes restart while cards are open.** Handled by `card.close {all_except_instance}` on connect, plus hub TTL.
   A **hub** restart keeps requests, because they are persisted. Callbacks written while the bot was offline are
   delivered on reconnect and may resolve to `expired`.
5. **`chat.stop` semantics.**
   - An idle `/stop` can also stop background delegations (`hc/gateway/slash_commands.py:466-470`). The hub only
     sends a stop for a chat with a live run, but the run may have just ended.
   - Does `_interrupt_and_clear_session` also drop the queued messages Hermes holds for that session? Verify, and
     document what happens to messages queued behind a stop.
   - The `EphemeralReply` "Stopped" appears as a bot message unless the plugin suppresses it.
6. **Run lifetime.** The 30 s idle timeout (`srv/bot-api.js:146`) must pause while requests are open. Otherwise the
   Stop button disappears during long approvals (`web/chat/Composer.tsx:182` shows it only while streaming).
7. **Storage.** Bot store writes rewrite the whole JSON file (`srv/bot-store.js:31-50`), so blobs **must** live
   outside it. Needs a quota, GC on prune, chat/agent/account deletion, and crash-safe ordering: blob rename before
   the store write, orphan sweep on start.
8. **Memory.** `media.serve` buffers whole bodies up to 25 MiB and caches 64 MiB (`srv/media.js:14,53-73`). Bot blobs
   should stream from disk.
9. **Throttling.** `/api/bot/media` and `/api/bot/rpc` must not share the per-IP *auth* throttle per call. This is an
   open blocker already listed in `design/notes/native-release-gates.md`.
10. **Media token scope.** Tokens bind only the account (`srv/media.js:36,43`). For bot media, also bind agent, bot
    and media id, and keep the 15 min TTL. Clients re-resolve on reopen.
11. **Mixed versions.** A 1.0 bot that reconnects after 1.1 traffic gets text placeholders for unacked media events.
    Open cards from a 1.1 instance are closed. Capabilities must flip back so the apps stop offering attachments.
12. **`user_id` binding in shared accounts.** Today a bot lives in one account's registry and every chat user is that
    account. If chats can ever be shared, bind requests to the turn's user (the `message.new` user), not to the
    account.
13. **Notifications.** The `approval` push deep link (`and/notify/NotifyNotifier.kt:53-66`) works by agent and chat,
    but needs `GET /queue` to return the open request so the card appears after the app opens. Covered by C.3.
14. **Not covered here:** reactions, groups/threads, voice-note STT (web mic uses browser speech recognition;
    `capabilities.voice` stays false), and `/model` or pickers over the bot channel (Telegram's `send_model_picker`
    and `send_choice_picker` would need card kinds beyond `approval`/`clarify`, which the apps ignore,
    `web/api/client.ts:31-33`).
