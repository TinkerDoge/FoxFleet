# Messenger Polish Implementation Plan

> **For agentic workers:** Use subagent-driven-development for focused implementation and independent reviews. Work only in this isolated worktree.

**Goal:** Deliver the approved Android media cache, synchronized reactions, temporary tool activity, and warm messenger refinement.

**Architecture:** Keep media persistence Android-owned and account-scoped. Keep message identity and reactions hub-owned. Extend existing event contracts without removing compatibility events. Both clients share Unicode reaction semantics and visual tokens.

**Tech Stack:** Node.js, Preact/TypeScript, Kotlin/Compose, Coil, Media3, existing JSON persistence.

## Task 1: Android media

- [x] Add cache tests for restart, eviction, corruption, account isolation, and deduplicated downloads.
- [x] Implement `media/MediaRepository.kt`, integrate `MediaCards.kt`, `MediaViewer.kt`, `ChatImage.kt`, `MainActivity.kt`, and account/cache settings.
- [x] Fix `ChatScreen.kt` local-image fullscreen fallback.
- [x] Run Android focused tests and compile; record physical-device performance as pending unless measured.

## Task 2: Reaction identities and hub

- [x] Test stable history IDs, duplicate identical messages, persisted reactions, actor isolation, idempotence, and invalid emoji.
- [x] Add persisted IDs in `server/history.js`; preserve IDs through native transcript normalization.
- [x] Add `server/reactions.js`, scoped routes in `server/index.js`, history integration and cleanup.
- [x] Define authenticated agent reaction action and advertise capability only on supported paths.
- [x] Extend `contract/openapi.json` and hub tests. Run `npm test`.

## Task 3: Tool activity

- [x] Test lifecycle frames preserve call/turn identity, overlapping calls, completion, replay, and session reset.
- [x] Extend `server/native-facade.js`, web stream client/store, Android stream callbacks/state.
- [x] Render icon plus safe one-line label; hide completed tool logs and empty tool-only historical rows. Preserve produced media and approval cards.
- [x] Run focused hub/web/Android tests.

## Task 4: Reactions in both clients

- [x] Bundle a pinned Twemoji pack/catalog with license and attribution; allow native fallback.
- [x] Preserve stable message IDs in both clients; reconcile live messages by authoritative history before enabling reactions.
- [x] Implement searchable full-catalog pickers, quick choices, pills/counts, participant details, idempotent add/remove, rollback, and refresh.
- [x] Verify restart and two-client behavior; test access and failure cases. (Automated: restart, idempotence, access, rollback. Two live clients: pending.)

## Task 5: Visual refinement and review

- [x] Refine current source-based layouts, shared tokens, media framing, activity and reaction spacing; preserve existing search/pins/previews.
- [x] Run production web build, web tests, Android build/tests, hub and contract checks.
- [x] Inspect fresh rendered web and Compose output; no historical screenshots as design evidence. (Web: fresh mock-hub shots, phone/desktop, light/dark. Compose: Robolectric suite only; device pending.)
- [ ] Perform independent spec review, then code-quality review. Fix findings and rerun affected checks.
- [x] Record evidence, remaining device/live-agent gates, and final branch status.

## Acceptance scenarios

```text
Media warm reopen: same scoped attachment + rotated URL => zero network resolution/download.
Reaction retry: PUT twice => one actor entry; DELETE twice => no entry.
Identity: identical adjacent messages => distinct stable IDs across pagination/restart.
Tool overlap: start A, start B, end A => only B remains; terminal/reset => none.
History: tool-only rows hidden; produced images and actionable errors retained.
```

Tests live alongside existing suites: `server/test`, `web/tests`, and `android/app/src/test/java/dev/foxfleet/app`. Keep automated proof separate from phone, IME, TalkBack, and live-agent evidence.

## Status (2026-10-11, resumed after the first session stopped)

- Automated: hub (all files except ones that fail identically on `main` on Windows: cli, agent-note golden, connector-doctor, machines, media symlink), contract, web tests + typecheck + production build, Android unit/Robolectric tests + debug APK.
- Pending: device timing (cold vs warm media), Bot Screen measurements, TalkBack/IME, a live agent calling `hub_react`, two real clients side by side, independent review.
