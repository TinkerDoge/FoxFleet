# FoxFleet 0.3.11-alpha — signed native-channel candidate

Android package `dev.foxfleet.app`, versionCode **24**, versionName **0.3.11-alpha**. This candidate has not been tagged/published as a GitHub release or rolled out to the existing fleet.

## Changes

- Bot approval and clarify cards on Android, independently of native Hermes model/profile controls.
- `foxfleet.replace` updates both visible streaming text and the accumulated assistant reply, including resumed streams.
- Stop and approval/clarify callbacks fail closed unless Hermes returns an explicit successful authorisation verdict.
- Integrated bot 1.1 supports real Stop, scoped cards, hub-owned media and standalone HTTP text delivery without opening another receive socket.

## Validation

- 185 plugin tests passed, including real-hub integration and 11 callback authorisation cases.
- 148 hub bot tests passed serially, without skips/failures.
- 10 focused Android tests passed on a fresh `--rerun-tasks --no-build-cache` run.
- 466 web tests passed; TypeScript and Vite build passed.
- Isolated DogeMint hub + normal Hermes gateway + `gpt-6.1-sol` passed real-model conversation, clarify answer/replay refusal, Stop/recovery, byte-verified ZIP delivery and standalone sending with the socket still connected.
- APK signature verified against the existing signing certificate, SHA-256 `df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df`. All 56 required screen/noVNC assets are present.

## Known limitations

- Release lint still has the same two errors as unchanged main: notification permission handling (`NotifyNotifier.kt:90`) and Android 10 WebP API compatibility (`AvatarStore.kt:61`). Both runs report 2 errors, 55 warnings and 5 hints. Signed assembly passed; lint is not claimed green.
- No physical-device acceptance in this session. Full public-fleet cutover and connector retirement are NOT part of this candidate.
- Production bot API remains disabled. Existing agents/connector are preserved. The auto-updater is paused to prevent unreviewed restarts; rollback snapshots exist on DogeMint.
- Existing drain-persistence/resend-notice and WebSocket login-throttle follow-ups remain recorded in `design/notes/native-channel-handoff.md`.
