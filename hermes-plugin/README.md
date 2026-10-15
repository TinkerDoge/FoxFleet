# FoxFleet Hermes platform plugin (`foxfleet`)

A native Hermes messaging platform for the FoxFleet hub, protocol `foxfleet.bot/1`. It runs inside
a profile's own Hermes gateway (the process that already serves Telegram, Discord and cron) and dials
**out** to the hub's bot WebSocket with a per-agent bot token. Hub users then chat with the agent the
way they would on any other DM platform. It is registered with `ctx.register_platform(name="foxfleet")`
and needs no Hermes core edits.

> **Status: text-only milestone. This is not a production-readiness claim.** It is tested against
> the real Hermes `BasePlatformAdapter`, plugin manager, config loader and stream consumer, with a
> strict fake hub and with the real hub module (see [Tests](#tests)). It has not been run in a
> production gateway or against a live channel, and the hub contract (`contract/bot-api.md`) is
> still moving.

## What works

- Text DMs in both directions. Slash commands arrive as plain text for the gateway router, and
  `commands.set` publishes a catalog for hub autocomplete (see [Commands](#commands)).
- `send` / `edit_message` / `delete_message` / `send_typing` map to `message.send` / `message.edit` /
  `message.delete` / `chat.action`, with `SendResult` carrying hub message ids. Streaming uses the
  gateway stream consumer through its supported cumulative-frame extension. The adapter maps
  snapshots to per-turn `send` / `edit_message` calls and splits UTF-8 messages losslessly.
- `platform_hint`, and `FOXFLEET_HOME_CHANNEL` for cron `deliver=foxfleet` **through a running
  gateway** (see [Deferred](#deferred)).

## Deferred (not supported, refused explicitly)

- **Out-of-process / standalone send** (cron or `send_message` with no running gateway). The hub keeps
  ONE socket per bot and closes the older one with 4009, so any extra socket would evict a live
  gateway on another host, which local locks cannot see; the evicted gateway then stops for good.
  There is no `standalone_sender_fn` until the hub offers a non-displacing transport.
- Media in either direction (base-adapter text fallbacks apply), group chats and threads (events are
  acknowledged with a WARNING and never reach the agent; outbound `thread_id` is refused), buttons,
  cards and reactions.
- `replay.gap` resync: `foxfleet.bot/1` never sends it, so receiving one is a fail-closed fault.

## Install

1. Copy (or symlink) this directory's `foxfleet/` folder into the plugins directory of the profile
   that should own the bot:

   ```bash
   cp -r hermes-plugin/foxfleet "$HERMES_HOME/plugins/foxfleet"   # e.g. ~/.hermes/profiles/<name>/plugins
   hermes --profile <name> plugins enable foxfleet
   ```

   The only dependency is `websockets` (≥ 15, with the `websockets.asyncio` client), which Hermes
   already ships. Nothing to `pip install`.

2. Mint a bot token on the hub. Per the hub milestone this is `POST /api/agents/<name>/bot-token`;
   the token is shown once. Put it in the **profile's** `.env`:

   ```bash
   FOXFLEET_BOT_TOKEN=ffb_...
   FOXFLEET_ALLOWED_USERS=<hub user id>[,<hub user id>...]   # default: nobody is allowed
   ```

3. Point the profile at the hub in its `config.yaml`. Both forms work. The top-level block is bridged
   by the plugin's `apply_yaml_config_fn`:

   ```yaml
   foxfleet:
     hub_url: https://fleet.example     # https required unless the hub is on loopback
     home_channel: <hub chat id>        # optional: cron / send_message default target
     allowed_users: [<hub user id>]     # optional alternative to FOXFLEET_ALLOWED_USERS
   ```

   ```yaml
   platforms:
     foxfleet:
       enabled: true
       extra:
         hub_url: https://fleet.example
   ```

   An explicit env value (`FOXFLEET_HUB_URL`, `FOXFLEET_HOME_CHANNEL`) beats YAML. When
   `FOXFLEET_BOT_TOKEN` is set, `env_enablement_fn` enables the platform.

4. Restart that profile's gateway.

### Settings

| Setting | Where | Notes |
| --- | --- | --- |
| `FOXFLEET_BOT_TOKEN` | profile `.env` (secret) | Read through `_shared.get_scoped_secret`, which is multiplex-safe and never `os.getenv`. Never copied into `extra`, never logged (see [Secrets](#secrets)). A `token:` key in YAML `extra` is ignored. |
| `hub_url` / `FOXFLEET_HUB_URL` | YAML (preferred) or env | `https://host[/prefix]`, or `wss://…/api/bot/ws`. Plain `http`/`ws` only for loopback. URLs with credentials, a query string or a fragment are refused. Redirects are refused, so the token never follows one. |
| `home_channel` / `FOXFLEET_HOME_CHANNEL` (+ `_NAME`) | YAML or env | Hub chat id for `deliver=foxfleet`. |
| `FOXFLEET_ALLOWED_USERS` / `allowed_users` | env or YAML | Comma-separated hub user ids. |
| `FOXFLEET_ALLOW_ALL_USERS` | env | `true` lets every hub user that can reach this bot talk to it. Off by default. |

### Authorization

The hub authenticates the humans; Hermes still authorizes them. Access is denied by default unless
the user is on `FOXFLEET_ALLOWED_USERS` (or `GATEWAY_ALLOWED_USERS`), has an approved pairing, or
`FOXFLEET_ALLOW_ALL_USERS` is set. The plugin does **not** set `trusted_inbound`, and
`authorization_is_upstream` stays `False`.

## Connection and handshake

- The client offers `Sec-WebSocket-Protocol: foxfleet.bot.v1` and authenticates with
  `Authorization: Bot ffb_...`. If the hub does not echo the subprotocol the connection is closed and
  the adapter stops (`foxfleet_protocol`, non-retryable). The first frame must be `hello` with
  `protocol: "foxfleet.bot/1"` and a 24-hex bot id.
- Close codes are fatal and are **not** retried:

  | Code | Meaning | Fatal error code |
  | --- | --- | --- |
  | 4001 | token rotated or revoked | `foxfleet_auth_rejected` |
  | 4003 | agent deleted, owner removed or disabled, or bot API off | `foxfleet_bot_gone` |
  | 4009 | replaced by a newer connection with the same token | `foxfleet_replaced` |
  | 1008 | policy violation (bot sent a non-object frame) | `foxfleet_policy` |

  The newest connection wins on the hub, and the adapter never fights it: after 4009 it stays down.
  HTTP 401/403, HTTP 400/426, a redirect and a changed bot id are fatal too. A hub `error` frame with
  a fatal code (`unauthorized`, `token_revoked`, `forbidden`, `version_mismatch`,
  `unsupported_protocol`, `replaced`) closes the socket at once without waiting for the hub.
  Everything else (1001, 1013, network loss) reconnects with exponential backoff and jitter
  (1 s to 60 s, reset only after a connection that stayed up 10 s). In each fatal case the locks are
  released and the gateway's fatal-error handler is notified.

## Inbound guarantees

Delivery is **at-least-once, not exactly-once.**

- The socket reader never runs the gateway. It validates frames and queues events on a bounded
  dispatch queue (256); a single dispatcher admits them in order.
- Event ids must arrive strictly contiguously per socket (`resume_from + 1, +2, ...`). A gap or
  inversion is a protocol fault: the socket is closed (1002) without acking and the hub replays.
  A duplicate on the same socket is ignored. `chat_id` / `message_id` / `reply_to` must match the
  hub grammar (`fc_` / `fm_` plus 16 base64url characters) or the frame is a fault and is not acked.
- `{t:"ack"}` is cumulative, strictly contiguous, and sent only after the plugin observed a **gateway
  acceptance receipt**: `event._gateway_accepted`, or a receipt the plugin stamps itself when the
  inline reply path completed, a non-draining runner busy handler returned `True`, or busy text
  was held in the debounce buffer. "The session was busy" is not a receipt, so a failed inline
  command is not acked and is redelivered.
- While the runner is draining (including external drain), ordinary unadmitted text is held at
  the ordered dispatcher without ACK, dedup mark, repeated notices or reconnects. When drain
  clears it is admitted once; disconnect leaves it at the hub for replay. The socket reader
  continues servicing RPCs. This is ordered backpressure: later events, including commands
  behind held text, wait too. Already accepted tasks also wait before calling the runner.
- If drain races an awaiting busy callback and it returns `True` without an actual acceptance
  flag, the adapter cannot distinguish rejection from an already-applied steer. It stops
  explicitly with non-retryable `foxfleet_admission_uncertain`, keeps the event unacked, and
  requires reconciliation before reconnect. It never guesses a receipt or auto-replays
  ambiguous side effects. Drain notices observed during RPCs remain recorded if drain clears.
- The admitted floor is persisted (mode 0600, `$HERMES_HOME/platforms/foxfleet/state-<hash>.json`)
  **before** the ack. If the write fails (for example ENOSPC) there is no ack, the floor is rolled
  back, a WARNING is logged and the socket resyncs; the replay is deduplicated and acked once the disk
  recovers. Events at or below the floor that a lagging hub replays are re-acked, not re-dispatched.
- A failed admission abandons the socket: nothing queued behind it is processed or acked, so the floor
  can never jump past an unadmitted event. The hub redelivers after the reconnect.
- A full queue pauses intake and resyncs after it drains. Nothing is dropped.
- A `replay.gap` frame is fail-closed: fatal, non-retryable `foxfleet_protocol`, nothing acked past it.
- Unknown *durable* event types are acknowledged in order without dispatch. The bot's own echoes are
  acknowledged and never become prompts.

### Acceptance crash window

"Accepted" means in-memory gateway acceptance (a task was spawned or the message was queued), **not**
durable agent completion. If the gateway crashes after the hub ack but before that turn runs, the turn
is lost even though the hub considers it delivered.

## Outbound semantics

- Every request is `{t, id, ...}` with only the fields the hub allows, answered by
  `{t:"res", id, ok, result|error}`. Request ids look like `r<n>.<hex>`; idempotency keys are 32 hex
  characters. In-flight requests are capped at 256 and fail as "outcome unknown" if the socket drops.
- **Idempotency.** After a lost response the adapter waits for the reconnect and resends with a new
  request id and the **same** key. The key is also kept for 5 minutes under the `(chat, text,
  reply_to, final)` fingerprint when the outcome stays unknown: a timeout, a malformed or missing
  `message_id` (it must match `fm_` plus 16 characters), a malformed `res`, or an `internal` error.
  A caller retry of the same content reuses the key; different content gets a fresh one.
- **`final`.** `message.send` and `message.edit` always carry an explicit boolean. `send` sets
  `final: true` only on the last chunk and only when Hermes marked the message user-visible final
  (`metadata.notify is True`, not `_interim_send`, not `expect_edits`). The adapter sets
  `REQUIRES_EDIT_FINALIZE` for explicit edit callers. Streaming instead uses Hermes' supported
  native cumulative-frame API: its turn-level `finalize` is distinct from edit-transport chunk
  sealing. Only the last chunk of the true final snapshot sets `final: true`; overflow heads,
  tool segments and interim commentary do not close the run. Ordinary busy notices and inline
  `/status`-style replies stay nonfinal even when notify-worthy; idle slash replies and active
  `/stop`/`/new`/`/reset` replies still finish promptly, without the 30 s timeout.
- Native snapshot edit targets are scoped to `(chat_id, turn_id)`, never the chat's last message.
  Corrected shorter finals remove only that turn's excess chunks. Terminal duplicate frames
  are no-ops while retained in the bounded stream cache. The hub displays distinct bubbles
  joined with two newlines in SSE; concatenating their transcript text preserves source bytes.
- **Text.** Empty or whitespace-only content is refused locally (`bad_format`) with no request. NUL
  characters are removed. Messages over 64 KiB of UTF-8 bytes are split losslessly (prefer newlines);
  `SendResult.message_id` is the last chunk's id and `continuation_message_ids` holds the earlier ones.
  An oversized edit is `too_long`.
- Hub error codes map to `SendResult.error_kind` (`rate_limited`, `forbidden`, `not_found`, `too_long`,
  `bad_format`, otherwise `unknown`); only `rate_limited` is `retryable`. Hub error text is never
  surfaced: results say `FoxFleet hub error <code>`, and a code outside the contract is `unrecognized`.

## Commands

On every connect `commands.set` publishes at most 100 entries, each only `{name, description}`, built
from the gateway-available commands of `COMMAND_REGISTRY` plus plugin commands. Names must match
`[a-z0-9_]{1,32}`: a hyphenated registry name is published with underscores only when
`resolve_command` maps that spelling back to the same command, otherwise it is omitted; plugin names
are included only if already valid. Descriptions have control characters stripped and are clamped to
256 characters. This is for autocomplete only; the gateway still decides what runs.

## Secrets

The token comes from the profile's scoped secret reader, never `os.getenv`, and is never written to
disk. websockets gets a per-connection logging adapter that renders no frame payloads, logs the
`Authorization` header as `<redacted>`, and withholds any other record that contains the token (raw or
JSON-escaped). Hub-controlled text (hello fields, error codes and messages, frame types) is never
echoed into logs, fatal messages or `SendResult`; protocol errors use static text.

## One owner per token

`connect()` claims ownership in this order, and a loser never dials the hub:

1. A same-process guard (the Hermes scoped lock lets the same PID re-acquire, so two multiplexed
   profiles sharing a token would otherwise both win).
2. Hermes' machine-wide scoped lock `foxfleet-bot` (gives `--replace` takeover and status messages).
3. An OS file lock, `foxfleet-bot-<sha256(url+token)[:32]>.flock` in Hermes' lock directory (mode
   0600, never contains the token, never deleted). The kernel releases it on any exit, crash included,
   so there is no stale lock. It is a `flock` (or `msvcrt.locking` on Windows), per open file, which
   also excludes a second adapter in the same process.

A second owner on the host fails fast with `foxfleet-bot_lock` (retryable). Everything is released on
`disconnect()` and on fatal errors. The lock only covers one host; two hosts with one token still
displace each other on the hub, and the evicted one stops with `foxfleet_replaced`.

## Tests

Two layers, neither a production-readiness claim:

- **Fake-hub suite** (`tests/fakehub.py`, labelled FAKE): a loopback aiohttp WebSocket server that
  models the real hub's wire rules (subprotocol, close codes, id grammar, field allow-lists, `final`).
  Covers admission, ordering, durability, idempotency, secrets and ownership against the real Hermes
  base adapter, plugin manager, config loader and stream consumer.
- **Real-hub integration** (`tests/test_realhub.py`): the actual hub module from a separate checkout
  (`createHub`, run by `tests/realhub/launch-hub.mjs` in a child Node process on an ephemeral loopback
  port with a throwaway data dir). Replies come from a *deterministic test handler* (no LLM or
  provider). It proves the real socket/wire contract against the real hub module, not a production
  gateway. `tests/test_native_lifecycle.py` additionally exercises the real base adapter and
  stream consumer against the same isolated hub: >64 KiB Unicode snapshots (first-send,
  progressive overflow and final-only), corrected finals, status/stop/interim notices, drain
  replay and fail-closed drain races. Its small runner shell is **not** a full GatewayRunner;
  replies are deterministic and no live provider is called. These integrations are skipped,
  with a reason, unless both variables point at existing paths:

  ```bash
  export FOXFLEET_TEST_NODE=/path/to/node              # Node 22+
  export FOXFLEET_TEST_HUB_SERVER=/path/to/hub/server  # directory containing index.js
  ```

The tests use the real Hermes source on `PYTHONPATH` and a disposable `HERMES_HOME`, lock dir and XDG
state, set up by `tests/conftest.py`. Every `FOXFLEET_*` variable is stripped (the two test variables
above are captured first). pytest and pytest-asyncio are **not** part of the Hermes venv, so install
them into an isolated target dir (documentation only):

```bash
python -m pip install --target /tmp/ff-pytest "pytest>=8,<10" "pytest-asyncio>=0.24,<2"
PYTHONPATH=/tmp/ff-pytest:/path/to/hermes-agent:hermes-plugin \
  /path/to/hermes-agent/venv/bin/python -m pytest -p no:cacheprovider -q hermes-plugin/tests
```

Do not import `gateway.run` in unit tests. It runs `hermes_bootstrap`, which provisions
dependencies for whatever data root it is pointed at.
