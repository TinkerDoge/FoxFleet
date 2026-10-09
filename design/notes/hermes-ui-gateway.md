# Hermes UI gateway (tui_gateway): protocol notes for the Foxfleet bridge

Verified 9 October 2026 against `NousResearch/hermes-agent` `0670ba45` by reading `tui_gateway/*.py` and `tui_gateway/contracts/*`, and by
running a **real** gateway (`python -m tui_gateway.entry`, Python 3.14, `uv pip install -e .`) against a local fake OpenAI-compatible model
(`server/test/fake-llm.js`) with no account and no network. Everything marked **[real]** was observed on that process. Everything marked
**[source]** was read but not run. Nothing here was run against Telegram, Discord, a dashboard `/api/ws`, or a production model.

## Launch, framing, readiness
- Start: `python -m tui_gateway.entry` in the Hermes environment with `HERMES_HOME=<profile dir>`. **Needs Python 3.14 with the project's pinned dependencies** (the editable install of this checkout only pins core deps for 3.14; on 3.13 `ruamel.yaml` was missing). **[real]**
- Framing on stdio: **one JSON object per line** (`\n`), UTF-8, both directions. Blank lines ignored; a bad line returns `{"error":{"code":-32700}}` with `id:null`. **[source]**
- Readiness: the first line out is a notification `{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":…,"change_events":true,"replay_epoch":"<hex>"}}}` (about 0.2 s warm, a few seconds cold). Requests sent before it are not guaranteed to be read. **[real]**
- `replay_epoch` identifies the gateway process: a different epoch after reconnect means the process restarted and in-memory sessions are gone. **[source]**
- EOF on stdin ends the process (`[gateway-exit] stdin EOF`); SIGTERM exits after a short grace. **[real]**
- The gateway **ingests provider keys from its environment** (it printed that it added `OPENROUTER_API_KEY` to the credential pool). Start it with the profile's own environment on purpose, never with an unrelated shell's keys. **[real]**

## Handshake after ready
1. `client.capabilities {"server_requests": true}` → `{"server_requests":["approval","clarify","sudo","secret","vault.*","preview.*","terminal.read","window.read","tour","setup_choose","display.install.sudo"],"declines_not_shown":true}`. **[real]** For stdio clients this is advisory (the "unanswerable" refusal applies to WebSocket clients that never advertised); we still send it. **[source]**
2. `gateway.capabilities` → `{"per_session_exclusive_submit":true}`. **[real]**
3. `ping` → `{"pong":true}`. **[real]**

## Identities (kept distinct in Foxfleet)
| Name | Meaning |
| --- | --- |
| `stored_session_id` | Durable SQLite session key, e.g. `20261009_220447_805203`. Input of `session.resume`. |
| `session_id` (runtime) | Process-local live handle, 8 hex, e.g. `aef50ad6`. Used by every other session method and on every event. Dies with the process. |
| `request id` | `srq-<12 hex>` on server→client requests; the response must echo it. |
| `seq` | Per-runtime-session monotonic event counter on each event (`params.seq`). |
| `user_row_id` | Row id of the persisted user message returned by `prompt.submit`. |

## Methods used by the bridge (params and results as observed)
- `session.create {cols, title?, idempotency_key?, model?, provider?, cwd?…}` → `{session_id, stored_session_id, message_count, messages, info{model,provider,lazy,profile_name,…}}`. `idempotency_key` makes a retried create return the same session. **[real/source]**
- `session.resume {session_id: <STORED id>, cols, lazy?, omit_messages?}` → snapshot `{session_id (runtime), session_key, info, messages, message_count, running, turn_started_at, inflight?, queued?, open_requests?, resumed}`. A live session is reused, otherwise rebuilt. Passing a runtime id gives `4007 session not found`. **[real]**
- `session.activate {session_id: <RUNTIME id>, omit_messages?}` → same snapshot, for sessions live in this process. Both attach a subscriber; neither starts an agent. **[real]**
- `session.events.since {session_id: <runtime>, last_seen: int}` → `{events:[params…], latest_seq, truncated, count, epoch, open_requests}`. The parameter is **`last_seen`, not `seq`** (`seq` is rejected with `4000 … Extra inputs are not permitted`). **[real]**
- `prompt.submit {session_id, text, queued?}` → idle: `{status:"streaming", user_row_id}`; **busy: `{status:"steered"|"redirected"|"queued"}`** chosen by the profile's `display.busy_input_mode` (default `interrupt`), unless `queued:true`, which forces `queued`. Rewind parameters (`truncate_*`) are refused with `4009` while busy. **[real/source]**
- `session.steer {session_id, text}` → `{status:"queued"|"rejected", text}`. **`queued` is the success status for steer (not "steered")**; an idle session answers `rejected` so the client sends it as a normal turn. **[real]**
- `session.redirect {session_id, text}` → `{status:"redirected"|"queued"|"rejected"}`; `rejected` when the agent has no active-turn redirect (it did not on our model setup). **Not mentioned in the Hermes programmatic-integration doc.** **[real/source]**
- `session.interrupt {session_id}` → `{status:"interrupted"}`; it also cancels open requests of that session (`request.cancel` with `reason:"interrupted"`). It does not wait for the turn to end; the end is the `message.complete` event. **[real]**
- `commands.catalog {}` → `{pairs:[["/new","desc (usage: …)"],…], …}`; `command.resolve {name}` → `{canonical, description, category}`. **[real]**
- `command.dispatch {name, arg?, session_id?}` → directive `{type: exec|plugin|alias|send|prefill|skill, output?, target?, message?, notice?, display?}`. **The params are `name` + `arg`, not `{"command":"/model x"}` as the programmatic-integration doc shows, and it does NOT run `/model` or `/busy`**: it only handles quick, plugin, bundle and skill commands plus the built-ins `queue q learn plan init moa focus retry steer goal loop undo snapshot compress memory skills`; anything else answers `4018 not a quick/plugin/bundle/skill command: model`. **[real]** Compress on a session whose agent is not built yet crashes the handler (`handler error: 'NoneType' object …`). **[real]**
- **`/model` is `config.set {key:"model", value:"<name> [--global|--once]", session_id}`** → `{key, value, warning, confirm_required, confirm_message, scope:"session"}`; without `--global` it is session-scoped, without a live session it is refused `4001`. **`/busy` is `config.set {key:"busy", value:"queue|steer|interrupt|status"}`: it writes `display.busy_input_mode` for the whole profile**, not for one conversation, and `status` only reads it. **[source]** Foxfleet therefore never changes it implicitly: per-message intent uses `session.steer`, `session.redirect`, `prompt.submit {queued:true}` instead.
- `model.options {session_id?, refresh?}` → `{providers:[{slug,name,is_current,models:[…],…}]}`. Large (hundreds of models) and probes custom providers; cache it. **[real]**
- `session.list {}` → `{sessions:[StoredSessionRow]}`; `clarify.lock {request_id, question_id, answer}` locks one answer of a batch early. **[real/source]**

## Events (notifications `method:"event"`, `params:{type, session_id, payload?, seq}`)
Seen on a real turn: `session.info`, `message.start`, `session.title`, `thinking.delta`, `message.delta {text}`, `reasoning.available`, `message.complete {text, usage, status}`, `status.update`, `tool.generating {name}`, `tool.start {tool_id,name,args}`, `tool.complete {tool_id,name,args,result,duration_s}`, `request.cancel {id,method,reason}`, plus session-less `sessions.changed`, `projects.changed`. **[real]**
- `request.cancel` carries its data in **`params.payload`** (`{id, method, reason}`), not at top level. **[real]**
- Some events have no `payload`; `session_id:""` events are process-wide.

## Server→client requests
`{"jsonrpc":"2.0","id":"srq-…","method":"clarify","params":{"session_id":rt,"questions":[{"qid":"q0","question":"…","choices":["staging (Recommended)","production"],"multi_select":false}]}}` **[real]**.
- Answer with a normal response bearing the same id: `{"id":"srq-…","result":{"answers":{"q0":"staging"}}}` (an empty `{}` cancels). Answer **once**; a late answer is dropped. `approval` → `{"choice":"once"|…}`. Unsupported methods → reply `error -32601` so the agent does not wait out the deadline. **[source]**
- Choices may be decorated (`staging (Recommended)`); answer with the text the user picked. **[real]**
- Reconnect: unanswered requests come back in `open_requests` of `session.resume`/`activate`/`events.since` as `{id, method, params}`. **[real]**
- The tool call `clarify` needs `questions: [{question, choices?}]`; the older `{question, choices}` shape is rejected by the tool. **[real]**

## Snapshot shape (resume/activate)
`inflight:{user, assistant (streamed so far), streaming:true, corrections?}`, `queued:{user}` (head of the gateway's own prompt queue; `queued_prompts` holds the rest), `running`, `turn_started_at`, `open_requests`. **[real]** `latest_seq`/`epoch` are **not** in the resume snapshot; get them from `events.since` and `gateway.ready`.

## Multi-viewer and ownership
Inside one gateway, `resume`/`activate` add a subscriber; a viewer leaving does not end the turn (`session_transports.py`). Ownership is not enforced: a foreign login is only logged. Independent gateway processes must never write one session. **[source]** On stdio there is exactly one transport (our connector); **fan-out to several browsers and phones is the hub's job**, and it must check the account before attaching.

## What the bridge does (connector `HermesGateway`)
One child process per shared profile, started lazily, restart with backoff (1, 2, 4… 30 s), `client.capabilities` after ready, `gateway.ready` / `gateway.down` surfaced to the hub, runtime id map `stored→runtime` cleared on restart. Allowlisted actions only: `info, create, attach, sessions, events.since, submit, steer, redirect, interrupt, catalog, resolve, dispatch (model,title,usage,status,compress,busy,reasoning,personality,help), models, lock, respond`. Only `approval` and `clarify` server requests are surfaced; all others are refused with `-32601`. Not relayed: `cli.exec`, `config.set`, `session.close`, `reload.*`, `terminal.*`, `image.attach`, anything else.

## Not verified
Dashboard `/api/ws` attach, WebSocket transport, `approval` on a real dangerous command (only `clarify` was driven), `session.redirect` on an agent that supports it, truncated `events.since`, cold resume after gateway restart, auto-continue after a crash, compression-time queueing, attachments, and any real provider. Hermes versions other than `0670ba45`.
