# FoxFleet native Hermes channel — session handoff

Written 2026-10-15 for the next session. This is a status handoff, not a claim that the channel is done.
`design/notes/native-release-gates.md` is **stale**: it still lists the streaming, login-throttle and onboarding bugs as open. Those three are merged. Trust this file and `git log` over that checklist.

## Goal

Make FoxFleet a native Hermes messaging platform, the way Telegram and Discord are: a `foxfleet` platform plugin inside the normal Hermes gateway, talking to a hub bot API. No connector, no dashboard password, no per-agent inbound port. Hermes-only. Other agent kinds (GLM, OpenCode, Grok, MCP-inbox) stay removed.

Live hub `fleet.indc.io.vn` and the six agents (`sumi`, `default`, `rose`, `renny`, `arzy`, `sam`) must stay untouched until an explicit, reviewed canary. Do not deploy. Do not set `FOXFLEET_BOT_API=1` on the live hub. Do not install the plugin into a live profile.

## Where the code is

- Repo: `TinkerDoge/FoxFleet`, local `/home/doge/projects/FoxFleet`
- Main: `f0aa25c` (`build(android): bump signed test build to versionCode 23`), pushed, clean, tracking `origin/main`
- Protocol: `foxfleet.bot/1`. Contract: `contract/bot-api.md`. Plugin: `hermes-plugin/`. Hub: `server/bot-*.js`. Web onboarding: `web/src/agents/NativeBot.tsx`
- Bot API is off unless `FOXFLEET_BOT_API=1` (`server/index.js` `createHub`)
- Merged fix branches still exist as worktrees. They are merged. Safe to remove after `git status` is clean in each:
  - `/home/doge/projects/FoxFleet-fix-hub` `fix/hub-rpc-throttle` `e12d6e5`
  - `/home/doge/projects/FoxFleet-fix-plugin` `fix/plugin-stream-fallback` `517ff73`
  - `/home/doge/projects/FoxFleet-fix-web` `fix/web-onboarding-409` `2fe48c8`

## What is done

Text DMs both ways, through a plugin that runs inside the normal Hermes gateway.

- Hub: bot tokens (`ffb_` + 43), durable store, contiguous ACKs, one WebSocket per bot, non-displacing `POST /api/bot/rpc` for `message.send/edit/delete` and `chat.action`.
- Rate limit: failed bot auth spends the shared per-IP login throttle. An already-locked IP is refused even with a valid token. Every authenticated HTTP request takes one per-bot token **before** the body is read, so bad or huge bodies are bounded. Invalid WebSocket frames cost a token. `ack`/`ping`/`pong` stay free on the socket only. Review of `fix/hub-rpc-throttle` passed.
- Web: Add native Hermes bot, one-time token, rotate/revoke, unknown-outcome lock with hub readback, navigation-safe exact-entry fencing. A 409 is classified by readback (it can be the user's own earlier write). Review passed. Suite 466/466, tsc and build passed on merged main.
- Plugin: stream-frame failure no longer splits the hub run or duplicates text. A drain no longer raises a fatal that kills the channel. Drain notices use a deterministic idempotency key (`notice-<kind>-` with `_` replaced, because hub keys are `/^[A-Za-z0-9._:-]{1,128}$/` and chat ids contain `_`). Suite 125 passed (baseline was 109). Isolated full-gateway harness on the fix branches: 19/19, local scripted provider, not a live model. Run dir: `/home/doge/.hermes/cache/scratch/foxfleet/gateway-e2e/run-20261015-123514-3fc1f176`
- Server suite on merged main before the plugin merge: 473 ran, 462 passed, 7 skipped, 4 failed. Those 4 match the pre-change baseline (connector doctor/discovery tests that depend on this machine). Do not treat a full server run as green.
- Signed APK vc23, same cert as vc21/vc22 (`DF:97:DD:3D:…:52:DF`), so it installs as an update. Package `dev.foxfleet.app`, versionName `0.3.10-alpha`, versionCode 23. Size 70823521. SHA256 `afb2078828721b6bf60d5890f2bdd4945438ce58c59df186c2012b9aaf28df5c`. MD5 `bd81efcf5fb3a4ff85743f74d5fa7c29`. Drive file `1Oemy5UGMMkdLP4xO9_ICXEcpgwQPoFm5`. Notes file `1vFWmGNKXCvd8mKw8JmGYFv8ff_aCCrME` in folder `1mz0x6icvdbDz8LWAdpZy6ZqQa1L04y3a`. Android app code did not change except versionCode. Native bot UI is web-only.

## Not done — this is the job

Order agreed with Doge: Stop, then cards, then media, then the plugin HTTP sender, then one canary. Do not retire the connector until the canary passes.

1. **Stop.** App Stop on a bot only ends the hub view (`server/bot-api.js` run link `stop`). Hermes keeps working. Both apps treat `/stop` as a local command and never send it to the bot.
2. **Approval / clarify / slash-confirm cards.** Reserved names exist and are refused. A tap must resolve only that request, user, chat and session. Stale, forged and replayed choices must be refused.
3. **Media both ways.** Refused today. Bytes through the hub, no connector filesystem allowlist, no machine paths in the apps.
4. **Plugin standalone sender.** Hub `POST /api/bot/rpc` exists. `hermes-plugin/README.md` still says there is no `standalone_sender_fn`. Cron and `send_message` with no running gateway cannot deliver. Update that README when the sender lands. It is stale.
5. **Android.** Research (re-verify before editing) says cards render only when `nativeUi` is set (`MainActivity.kt` around line 177). Do not flip `nativeUi` on for bots: both apps would send `/model` to a picker bots cannot serve. Drop that gate instead, then sign a new APK. Android also ignores `foxfleet.replace`, so a rewritten bot reply stays stale until reload.
6. **Canary.** One profile, plugin installed, `FOXFLEET_BOT_API=1` on a hub that can be rolled back. Real conversation. Then the other agents. Never delete the connector to make the branch look clean.
7. **Gates note.** Update `design/notes/native-release-gates.md` so the three merged bugs are checked off. Do not check Stop, cards, media, standalone sender, or canary.

Groups, threads, reactions and buttons are explicitly out of v1. Not required to retire the connector for normal DMs.

## Phase 2 design (proposal, not implemented)

Copied into this repo as `design/notes/native-phase2-research.md` (from scratch; scratch can be pruned). Facts in that file are cited. The contract delta is a proposal. Re-read the live app code before coding from it. Short version:

- Web needs no change if the hub serves the routes the apps already call (`open_requests`, request answer route, `/api/media`).
- Stop: hub sends a one-off `chat.stop` that is never replayed. Plugin feeds a synthetic `/stop` through Hermes' normal message path. Hub reports confirmed only when the bot answers.
- Cards: bot `card.send`, hub mints a request id bound to bot+chat+user, apps see the shapes they already render, answer is one-shot, `card.close` on timeout or old-process reconnect.
- Media: `POST`/`GET /api/bot/media`. Outbound replies use `MEDIA:` refs the apps already resolve. Do not put media files inside the bot JSON store. Do not let media uploads spend the login throttle.
- Idle timeout must not kill a run while a card is open, or Stop disappears during a long approval.
- Hermes relay adapter (`gateway/relay/adapter.py`) is the reference for remote prompts. Slash-confirm resolves through `tools.slash_confirm.resolve`, not the name in the base docstring. Approvals have a `request_id` before the prompt is sent.

## Rules for the next session

- Node 22: `/home/doge/.hermes/node/bin` on `PATH`. Node 26 breaks web `localStorage` tests.
- `TMPDIR` under `/home/doge/.hermes/cache/scratch/foxfleet/tmp`.
- Plugin tests: `/home/doge/.hermes/cache/scratch/foxfleet/run-plugin-tests-main.sh` (WT is main). The `run-plugin-tests-fix.sh` copy points at the plugin worktree.
- Hub tests: `cd /home/doge/projects/FoxFleet && PATH=/home/doge/.hermes/node/bin:$PATH npm test`. Expect 4 baseline failures unless they have been fixed since this handoff.
- Web: `cd web && npm test` then `npx tsc --noEmit` and `npm run build`.
- Signing material is `~/.config/foxfleet-signing/` (0700). Never print passwords, never put them in worker prompts, commits, or chat. Gradle reads `FOXFLEET_KEYSTORE`, `FOXFLEET_KEYSTORE_PASSWORD`, `FOXFLEET_KEY_ALIAS`, `FOXFLEET_KEY_PASSWORD`. JDK 17: `/home/doge/.local/opt/jdk-17`. After a rebuild, `apksigner verify --print-certs` must show cert SHA-256 `df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df`, and versionCode must be higher than 23.
- Workers do not commit, push, deploy, or touch the git index. Parent reviews, tests, commits, pushes.
- Fail-closed review before merge when the change is lifecycle or auth. Doge explicitly approved GLM-5.3 reviewers on 2026-10-15 after asking. His standing rule is still: never auto-use GLM unless he asks. Ask again next session.
- Quota: Codex/ChatGPT subscription and Anthropic both 429'd during this work. Devin Fusion and Agy Opus were already exhausted earlier. Do not assume a coding-agent CLI is available. Hermes `delegate_task` works. If a worker dies on quota, the tree may still be green and half-finished: run the suite yourself, then review against the brief.
- Commit and push shared repo changes. Do not deploy indc or the live hub without an explicit yes.

## Known residuals (not blockers for the text milestone, do not ignore)

- Drain-notice follow-up `517ff73` was merged because Doge said merge, while re-review `deleg_2728ba97` had not returned a verdict. Check that transcript before trusting the notice path: `/home/doge/.hermes/cache/delegation/live/deleg_2728ba97/task-0.log`. If it failed, fix on top. Do not rewind main.
- A crash after a processed message, before the "remove from unprocessed" save succeeds, can still produce one false "please resend" after restart. Repeats of a real notice collapse on the deterministic key.
- WS upgrade still spends the per-IP login budget on every attempt, valid or not. Same as before the HTTP fix. A bot reconnecting its socket more than 60 times a minute from one IP can lock owner login. Follow-up, not done.
- Idempotency keys reject `_`. Any new key built from a chat id must replace `_`.
- Full server suite is not green. Four connector doctor/discovery failures are the baseline on this machine.

## Do not

- Deploy or restart the live hub, connector, or the six agents.
- Generate a new Android signing key.
- Reintroduce non-Hermes agent kinds.
- Open a second bot WebSocket for cron or `send_message`.
- Treat an admission ACK as proof the agent finished the turn.
- Treat the gates file's open checkboxes for streaming, throttle and onboarding as still true.
