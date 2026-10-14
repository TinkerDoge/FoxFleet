# FoxFleet as a native Hermes messaging platform

Status: proposal (branch `feat/hermes-native`), 2026-10-14. Hermes surveyed: v0.22.0+119 (`0e427d78`).

## TL;DR
Stop driving Hermes from outside. Ship a **`foxfleet` Hermes platform plugin** (same slot as `plugins/platforms/telegram`,
`discord`, `buzz`, `a2a`) that runs **inside each profile's own gateway** and dials **out** to the hub over one WebSocket with a
per-agent bot token. The hub becomes a chat server (think Telegram Bot API), not a remote control for Hermes internals.

## What we do today (the kitbash)
- `connector/foxfleet-connector.mjs` (one Node sidecar per machine) discovers profiles by poking `~/.hermes` files, reads dashboard
  passwords / API keys out of each profile's `.env`/`config.yaml`, and:
  - tunnels HTTP + WebSocket to the **dashboard (:9119)** and **API server (:8642)** through the hub (`server/connector.js` opens
    loopback forwarders per agent);
  - spawns its **own** `python -m tui_gateway.entry` per profile and drives it over stdio JSON-RPC (`UI_OPS` allowlist).
- `server/hermes-ui.js` re-normalises TUI events into `foxfleet.native/1`, keeps its own admission journal, ownership map, replay log.
- `server/hermes-commands.json` is a **frozen copy** of Hermes `COMMAND_REGISTRY`; the connector has its own `DISPATCH_OK` subset.
  `/model` and `/busy` are special-cased because `command.dispatch` refuses them.
- Behaviour hints are a `<foxfleet-note>` **prepended to the user's message**, then stripped again in `server/transcript.js`.

### Why it hurts
1. **Two runtimes per profile.** The profile's real gateway (Telegram/Discord/cron) and the connector's private `tui_gateway`
   are separate processes with separate in-memory state, busy queues and agent caches. FoxFleet is not a channel of the agent,
   it is a second agent wearing its config.
2. **Hermes can't address FoxFleet.** No `send_message` target, no cron `deliver=foxfleet`, no home channel, no
   `get_connected_platforms()` entry, no pairing/allowlist, no platform hint in the system prompt.
3. **Coupled to internals.** `tui_gateway` method names, param quirks (`last_seen` not `seq`, `name`+`arg`), dashboard login
   flow and hashed-password edge cases are private surfaces that change between Hermes versions. Every Hermes update risks a break.
4. **Secret handling.** The connector reads every profile's dashboard password and chat API key to make it work.
5. **Slash commands drift.** Frozen JSON + allowlist + plaintext fallback = "advertised ≠ dispatched" (see the foxfleet skill).

## Target: the Telegram shape
```
 phone/web ──HTTPS/WS──► FoxFleet hub ◄──WSS (bot token, outbound)── Hermes gateway[profile] ── plugins/platforms/foxfleet
                         (users, chats,                               (same process that already
                          messages, media,                              serves Telegram/Discord/cron)
                          cards, push)
```
Each Hermes profile is a **bot account** on the hub. The hub owns users, chats, message history, media and push. Hermes owns
the agent, sessions, slash commands, approvals and tools, exactly as it does for Telegram.

### Hermes side: `foxfleet` platform plugin
Registered with `ctx.register_platform(name="foxfleet", ...)` (see `gateway/platforms/ADDING_A_PLATFORM.md`). Zero core edits.
Ships from this repo as `hermes-plugin/foxfleet/` and is installed into `~/.hermes/plugins/` (later: upstream PR).

| `BasePlatformAdapter` surface | FoxFleet mapping |
| --- | --- |
| `connect()/disconnect()` | WSS to `hub/api/bot/ws`, `Authorization: Bot <token>`, backoff+jitter, resume with `last_event_id` |
| inbound → `MessageEvent` via `self.build_source(...)`, `self.handle_message()` | hub `message.new` frames; dedupe with `MessageDeduplicator` |
| `send / edit_message / delete_message` | `message.send / message.edit / message.delete` → hub returns `message_id` |
| streaming | `send` + `edit_message` (gateway stream consumer), later `send_draft` if we want animated drafts |
| `send_typing` | `chat.action typing` |
| `send_image_file / send_document / send_voice / send_video` | `POST /api/bot/media` (multipart) → `message.send {media:[id]}`. Kills `MEDIA:` path allowlists and the media proxy |
| `send_clarify`, `_send_exec_approval_prompt`, `send_slash_confirm`, `send_choice_picker`, `send_model_picker` | `message.send {card:{buttons}}`; taps come back as `callback` frames with the shared ids `cl:<id>:<idx>`, `appr:<id>:<choice>`, `sc:<choice>:<id>` so core resolvers work unchanged |
| reactions | outbound `message.react`; inbound reaction frames → `set_reaction_handler` |
| slash commands | arrive as plain `/cmd` text; the gateway's own command router handles them (same as Telegram). On connect the plugin pushes `commands.set` built from `COMMAND_REGISTRY` so autocomplete is live, not frozen JSON |
| `platform_hint` | replaces `<foxfleet-note>` injection: proper system-prompt hint, no message mangling |
| `cron_deliver_env_var=FOXFLEET_HOME_CHANNEL`, `standalone_sender_fn` | cron + `send_message` targeting works |
| config | `FOXFLEET_HUB_URL`, `FOXFLEET_BOT_TOKEN` (per-profile `.env`, read via `_shared.get_scoped_secret` so `multiplex_profiles` is safe), `FOXFLEET_ALLOWED_USERS`, `FOXFLEET_HOME_CHANNEL` |
| authz | hub authenticates humans; the bot sees stable hub user ids. Default deny + `FOXFLEET_ALLOWED_USERS` / pairing, like every other direct adapter. Do **not** claim `authorization_is_upstream` in v1 |

Session mapping: `chat_id` = hub chat id, `thread_id` = hub thread (optional), `user_id` = hub user id, `chat_type` dm|group.
Hermes builds session keys from that, so FoxFleet chats get the same continuity, `/new`, `/retry`, `/undo`, `/compress` as Telegram.

### Hub side: bot API (new, small)
- `POST /api/agents` (admin) mints a bot token (store hash only), shown once / delivered by pairing link.
- `GET /api/bot/ws`: one socket per bot. Frames, JSON, every frame has `id` + monotonic `event_id`:
  - hub → bot: `hello{bot, resume_from}`, `message.new`, `message.edited`, `callback`, `reaction`, `ping`
  - bot → hub: `message.send|edit|delete|react`, `chat.action`, `commands.set`, `ack{event_id}`, `pong`
- `POST /api/bot/media`, `GET /api/bot/media/:id` (size cap, mime sniff).
- Store: chats, messages (author = user | bot), media, cards; at-least-once delivery to the bot with acks + replay buffer
  so an agent restart doesn't lose inbound messages.
- Clients (web/android) only talk to the hub's existing user API; they no longer care what "kind" an agent is.

## What gets deleted once the plugin lands
`connector/foxfleet-connector.mjs`, `server/connector.js`, `server/hermes.js` (dashboard/API client), `server/hermes-ui.js`,
`server/hermes-runs.js`, `server/hermes-commands.json`, `server/native-facade.js`, `server/media-proxy.js`, the screen-takeover
tunnel (keep as optional later), `<foxfleet-note>` stripping in `transcript.js`, `DISPATCH_OK`, the machine pairing flow
(replaced by per-bot tokens), and the per-profile dashboard password requirement.

## Things we lose or must re-decide (honest list)
- **Structured tool events / reasoning stream.** tui_gateway gave typed `tool.start/complete` + `reasoning.delta`. A platform
  adapter gets the gateway's rendered tool-progress bubble (`display.tool_progress`) and `show_reasoning` text instead.
  Fine for a chat app; if we want rich tool cards, add optional structured metadata to the send frames later.
- **Browsing all Hermes sessions** (CLI/TUI ones) from FoxFleet: out of scope. FoxFleet shows FoxFleet chats, like Telegram.
- **Steer / queue / interrupt per message:** gateway already implements busy modes + `/stop`, `/steer`, `/queue` for platforms.
- **Screen takeover / VNC:** separate feature, not messaging. Park it.

## Migration plan
0. **Done on this branch:** strip non-Hermes agent kinds (openai, openrouter, zai/GLM, opencode, grok, mcp-inbox) from server,
   web, android, contract, tests, docs. Kind field kept, Hermes-only, so other kinds can return as bot-API clients later.
1. Hub bot API + store (behind a flag), contract vectors + tests.
2. `hermes-plugin/foxfleet`: text in/out, typing, edits/streaming, dedupe, reconnect. E2E against a real profile on M700.
3. Media, cards (clarify/approval/confirm/pickers), reactions, `commands.set`, platform hint, cron/home channel.
4. Web + Android: render cards from hub messages instead of `foxfleet.native/1` events.
5. Cut over Sumi/Rose/Renny (M700) then Sora/Arzy/Sam (DogeMint); delete the connector stack.
6. Later: non-Hermes agents come back as thin bot-API clients (any language), not hub-side provider plugins.
