# FoxFleet native Hermes channel — current handoff

## Release state

Release **0.3.11-alpha**, Android **versionCode 24**, includes bot cards/reply replacement and fail-closed callback auth. Auth merged as `02d2770` (`f62ae61`); Android/version merged as `c42ed3d` (`ce1a13e`), both pushed. Only main remains; both feature branches/worktrees were removed. The independent read-only review `deleg_695da8fc` passed with no security or logic findings.

The signed APK was rebuilt from clean main with all 52 tasks executed (`--rerun-tasks --no-build-cache`). Final size 70823521 bytes; SHA-256 `991b1834bba3f2286398dcde387e6a42e4f49ba0dadf66de3922fa524bfb5be1`; MD5 `bc1e73708d9c41969ef89dc8271c7470`. Existing certificate and all 56 required screen assets verified. Merged-main re-runs: 185 plugin and 148 hub bot tests passed, no skips/failures. Logs and binary are under `/home/doge/outputs/foxfleet/`. The isolated canary profile, tunnel, service and data were removed; rollback snapshot retained.

Doge approved an isolated canary, then merge/push, branch cleanup and signed rebuild. He asked SUMI to do the implementation/release work herself. A separate reviewer is read-only, not an implementation worker.

## Existing integrated features

- Stop: `9e57fd5` (`b5f3aba`). 1.0 refuses interruption; 1.1 uses a transient, non-replayed `chat.stop`. Only `stopped`/`idle` end the run view.
- Scoped approval/clarify/confirmation cards: `69c44a8` (`67c0ca0`). Hub-minted request IDs, single-shot answers, exact pending-approval binding.
- Media: `2725927` (`6210935`). Hub-owned bytes outside the JSON store, sniffed MIME, 25 MiB/file and 1 GiB/bot limits. No bot-supplied URL fetch. Plugin uploads only Hermes-accepted delivery paths. Plain text, SVG, HTML and executable uploads are intentionally refused; supported archives work.
- Standalone HTTP sender: `88ff447` (`c77e5c3`). Text-only `/api/bot/rpc`, no second socket, same-key retry, exact HTTP 200 plus `fm_` ID required, hub path prefixes retained. Environment proxies disabled on socket/RPC/media transports.
- Auth hardening in this release: Stop and card side effects require `_is_sender_authorized(...) is True`; absent, throwing, non-boolean and negative checks all refuse. Denied card callbacks do not pop their pending approval.
- Android in this release: `capabilities.bot` enables only card answers, not `nativeUi` or the model picker. `foxfleet.replace` resets both the stream display and the accumulated/committed reply; non-string payloads are ignored.

## Verified execution

Parent-run evidence, not worker self-reports:

- Full plugin suite: **185 passed**, zero failures/skips, against the real local hub module. `FOXFLEET_TEST_HUB_SERVER` must be the `server/` directory, NOT `server/index.js`.
- Hub bot suite: **148 passed**, zero failures/skips, with `node --test --test-concurrency=1 server/test/bot-*.test.js`.
- Fresh focused Android suite: **10 passed**, zero failures/errors/skips; `--rerun-tasks --no-build-cache --offline`, 31 tasks executed. Initial cached Gradle success was not counted.
- Auth TDD: before the guard changes, eight tests reproduced the unknown-auth bypass. Afterwards the whole plugin suite passed.
- Logs: `/home/doge/outputs/foxfleet/auth-plugin-tests.log`, `auth-hub-tests.log`.

## Isolated real-model canary — PASSED

The production owner account has not been used for tests. The canary ran a second hub on **DogeMint**, bound only to `127.0.0.1:3081`, same server code as production (`88ff447`), with its own data root `/home/dogetinker/.local/share/foxfleet-canary`.

One newly created Hermes profile, `foxfleet-canary`, on M700 loaded the tested plugin through normal plugin discovery and ran the normal Hermes gateway with **`gpt-6.1-sol` / `openai-codex`**. It was explicitly standalone (`gateway.standalone: true`), so it did not take over existing agents. An SSH loopback tunnel linked the hosts.

Actual probes passed:

1. Live-model text round trip: `CANARY_NATIVE_OK` in hub transcript.
2. A real `clarify` tool card was answered Beta; model returned `CANARY_CHOICE_Beta`. Repeated submission was refused.
3. Hub Stop returned `confirmed: true`; a subsequent turn returned `CANARY_AFTER_STOP_OK`.
4. Gateway delivered a ZIP via the hub media store. Authenticated download matched source bytes and SHA-256. The initial `.txt` attempt was rejected by the designed media type allowlist, not counted as delivery.
5. `hermes --profile foxfleet-canary send` delivered `CANARY_STANDALONE_OK` exactly once while the receiving socket remained online.

Full readback evidence: `/home/doge/outputs/foxfleet/canary-results.json`; gateway log: `canary-gateway.log`. Test-only credentials are private in the canary profile, never in git or chat.

This is **not** a fleet migration or a physical-device acceptance test. Public-hub rollout and retirement of the connector remain separate gates.

## Production and rollback facts

- Live hub: `fleet.indc.io.vn` -> DogeMint `10.77.77.2:3080`, user service `foxfleet.service`, repo `/home/dogetinker/foxfleet`.
- Its auto-updater had already deployed main `88ff447` at 20:13:17 +07 before the canary. Earlier statements saying the merged code was not deployed were incomplete: the **bot API remained disabled**, but the source had auto-deployed.
- Production `FOXFLEET_BOT_API` remains unset; `/api/auth` does not advertise `botApi`.
- Existing six agents (`sumi`, `default`, `rose`, `renny`, `arzy`, `sam`) and connector configuration are not migrated/deleted.
- The one-minute auto-update cron was paused before tests. It resets to `origin/main`, builds web and restarts BOTH hub and connector; do not restore it blindly during a release. Check and record final cron state.
- Backup: `/home/dogetinker/.local/share/foxfleet-canary-backup-20261015-212004/` (0700), containing data archive, env, original crontab, hashes and rollback manifest.
- Service sandbox `ReadWritePaths` includes the entire production data root; bot media is beneath it. The isolated canary used separate data, not production snapshots.

## Signing and commands

- Signing material: `~/.config/foxfleet-signing/` (0700). Existing alias `foxfleet`, cert SHA-256 `df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df`. Never generate another key or print passwords.
- Build env: `JAVA_HOME=/home/doge/.local/opt/jdk-17`, `ANDROID_HOME=/home/doge/Android/Sdk`. Gradle reads `FOXFLEET_KEYSTORE`, `FOXFLEET_KEYSTORE_PASSWORD`, `FOXFLEET_KEY_ALIAS`, `FOXFLEET_KEY_PASSWORD`.
- Verify APK signature, application ID/version, packaged assets, SHA256 and MD5 before delivery. Preserve vc23 for rollback.
- Plugin test Python: installed Hermes workspace on `PYTHONPATH`, plus `/tmp/foxfleet-sender-test-deps`; full runtime has pytest there, not in bare python3.
- Node 22: `/home/doge/.hermes/node/bin/node`. Node 26 changes web localStorage behaviour.

## Known residuals — do not hide

- Drain persistence race: a crash after processing but before the unprocessed-row removal is saved can produce a false resend notice after restart. Existing post-merge audit; not repaired by the auth/Android slice.
- WS upgrade still spends the per-IP login budget on every attempt. Follow-up, not repaired here.
- Historical full server suite has four connector doctor/discovery baseline failures. The 148-test bot subset is green; do not call the whole repository suite green.
- No physical Android device QA in this session. Do not check the full web-and-Android user-facing gate based only on JVM tests.
- Release lint reproduces the same **2 errors, 55 warnings, 5 hints** on unchanged main and this candidate: NotifyNotifier.kt:90 MissingPermission and AvatarStore.kt:61 NewApi (WEBP_LOSSY on API 29). Not new regressions; not claimed green. Signed assembly, certificate, version and APK asset verification succeeded.
- Canary gateway and sidecar were stopped after verification; production hub/connector remained active and bot-flag-off. Auto-update remains intentionally paused pending a separate production deployment decision.
- Groups, threads, reactions and arbitrary buttons are out of this bot protocol slice.

- Contract alignment (2026-10-19): `models.set` documented in contract/bot-api.md, valid+invalid vectors and a limits test added (merged from fix/rooms-contract-baseline). Repairs the two pre-existing bot-contract baseline failures; no production source changed.
