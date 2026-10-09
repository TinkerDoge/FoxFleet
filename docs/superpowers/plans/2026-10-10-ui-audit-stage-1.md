# UI audit Stage 1 implementation plan

**Goal:** Implement the dependable-current-experience recommendations A02–A07 from `docs/UI-DESIGN-AUDIT.md` on `codex/ui-audit-stage-1`.

**Architecture:** Keep the existing Preact shell, shared tokens and hub protocol. Navigation owns the requested agent/session; guarded asynchronous loads own its transcript. History and execution have explicit independent states. Recovery attaches to existing work and only offers resubmission after a definite rejection. Mobile navigation behaves as a modal; header and attachment actions follow the existing History keyboard model.

**Tech stack:** Preact, TypeScript, Vitest/jsdom, shared JSON tokens and generated CSS/Kotlin, Chromium against the mock hub.

## Scope and decisions

The audit is the approved design direction. Follow its delivery order: complete a reviewable first implementation of Stage 1 before expanding navigation or cross-device read semantics. This branch starts with web behavior and shared contrast improvements, including Android status-pill text colours. Android-specific interaction and recovery work remains a follow-up; generated Android colours stay consistent.

Keep the restrained fox identity and current composer. Use real run IDs and terminal protocol events for status. A broken connection offers **Reconnect to reply** or **Check request status**, never an automatic second task. A definite rejected request offers **Retry request**. Regeneration via `/retry` stays an explicit new execution.

## Tasks

- [x] **A02: Conversation routing.** Add regression cases in `web/tests/chat-navigation.test.tsx` and `web/tests/chat-state.test.ts` for same-agent links, rapid responses, New chat, remembered chats, active-run navigation and draft isolation. Update `web/src/chat/ChatView.tsx`, `web/src/chat/store.ts`, and `web/src/router.ts` so History/New chat change the route, URL reflection does not overwrite external navigation, and stale transcript/run results are ignored. Run `npm --prefix web test -- tests/chat-navigation.test.tsx tests/chat-state.test.ts tests/drafts-persist.test.tsx tests/runs.test.ts`.
- [x] **A04: History state.** Track history errors in the chat store, independently of transcript loading; preserve rows on refresh/pagination failure, distinguish failure from empty history and clear errors after success. Update `SessionsMenu.tsx` to display loading and an explicit Retry action. Cover initial, stale and paginated failures, including expired authentication, in `chat-state.test.ts` and `chat-navigation.test.tsx`.
- [x] **A05: Safe recovery and run state.** Represent submitting, accepted, working, terminal and interrupted-connection states in `store.ts` using stream callbacks. Preserve resumable run identity; offer transcript reload, existing-run reconnect, uncertain-request status check or definite-rejection retry in `ChatView.tsx`. Cover no-duplicate recovery, stale callbacks and protocol failure in `chat-state.test.ts`; run existing queue/native chat suites.
- [x] **A03/A07: Responsive actions and keyboard behavior.** Add a reusable keyboard action menu for compact header/attachment controls, protected ellipsis for identity, an ordinary chat `h1`, and mobile focus containment/inert background/restore in `Shell.tsx`. Route focus follows agent/session changes. Add keyboard regressions in `web/tests/action-menu.test.tsx` and `web/tests/shell-focus.test.tsx`. Inspect 320px Large text, 390px, desktop, long names and resize in Chromium.
- [x] **A06: Meaningful text contrast.** Extend `web/tests/a11y.test.ts` to include faint text and actual status-text/tinted-background pairs in both themes. Update `design/tokens.json`, generate CSS/Kotlin with `node design/tools/gen-tokens.mjs`, and use separate status text colours in web controls. Apply the generated status text tones to Android pills; keep Android interaction and recovery outside this first implementation. Update `docs/ACCESSIBILITY.md` to state tested coverage and pending manual checks accurately.
- [x] **Verification and review.** Run all web tests, production build, token-generation check, and relevant browser scenarios against isolated mock data. Record test counts and browser evidence here; explicitly retain real-device/IME/TalkBack, screen-reader and usability gates. Review the diff and preserve unrelated `docs/HERMES-SLASH-PARITY.md`.

## Later audit stages

- Stage 2: A01, A09, A13 — conversation discovery/search, conversation unread/read semantics and identity; validate retrieval with 30+ conversations and duplicate titles.
- Stage 3: A08, A10–A12 — Android keyed drafts and history access for unavailable agents, whole-answer reuse, first-use guidance; validate on actual Android hardware.

## Evidence

Initial checkout: `main` at `3c242a4` (version `0.3.1-alpha`, newer than the audited `0.2.1-alpha`). No tracked local edits; one unrelated untracked slash-parity document. Baseline test attempt could not start because web dependencies were absent; install the pinned lockfile before testing.

Human/device acceptance remains pending after automated verification.

## Delivered implementation and verification — 10 October 2026

Implementation is isolated at `E:\Code\FoxFleet\.worktrees\ui-audit-stage-1` on `codex/ui-audit-stage-1`, based on `3c242a4`. Another active task switched the shared checkout to `feature/hermes-slash-parity` while this work was in progress. The UI source and tests were moved into this worktree, and shared Composer/translation/style edits were reconstructed around the original base. The independent slash-parity sources are not part of this UI branch.

Implemented behavior:

- Agent/session URLs, History, reload and Back/Forward agree. Explicit blank chats use `new=1`, distinct from remembered-agent navigation, and retain their own drafts when revisited.
- Late transcript/run results and late deletion responses cannot redirect or overwrite a newer conversation. Run discovery keeps Send unavailable until existing work is checked. Unknown-agent links show an unavailable view.
- History failures retain stale rows, show a separate explanation and Retry, and do not look like an empty list. Successful refresh clears the error.
- Request state separates submission, hub acceptance, execution, completion, failure, stopping, disconnected and unknown outcomes. Reconnect follows existing work without resending; expired streams preserve partial text and resumable identity without claiming completion.
- Compact header actions, ellipsis and 44px frequent mobile targets protect a 320px Large-text header. Attachment and overflow menus support keyboard navigation/dismissal/focus restoration. Phone navigation contains focus and makes the background inactive until dismissal or desktop resize.
- Meaningful faint text passes normal-text contrast on the tested surfaces. Web status text and Android Ready/Online/Offline pill text use readable foregrounds independently of status dots/tints.

Verification from the isolated branch:

| Check | Result |
| --- | --- |
| Complete web suite | 25 files, 183 tests passed, including the local mock-hub contract |
| Focused UI regression rerun | 5 files, 48 tests passed |
| Web production build | Passed: generated tokens, TypeScript and Vite |
| Android compile and unit tests | `:app:compileDebugKotlin :app:testDebugUnitTest` passed; 194 tests, zero failures/errors/skips |
| Token generation / whitespace | `node design/tools/gen-tokens.mjs --check` and `git diff --check` passed |
| Chromium scenarios | 14 checks passed with zero application errors; isolated mock data |
| Independent review | All five correctness findings fixed; focused review tests passed |

Android compilation reported existing deprecation and Rive-initializer warnings. It is build/unit-test evidence, not device acceptance.

Browser evidence is under [images/ui-audit-stage-1](../../images/ui-audit-stage-1/observations.json): desktop, stale-history failure, 320px Large text, long identity, modal drawer and dark phone screenshots. The reproducible browser runner is `web/tools/ui-audit-check.mjs`; pass an output directory and optional installed Playwright runtime root. Its mock server binds only to localhost and shuts down after the run.

Pending acceptance: real Android hardware, IME/keyboard and landscape, rotation/process recreation, TalkBack/NVDA/VoiceOver and usability sessions. Stage 2 and Stage 3 remain future implementation work; Android-specific Stage 1 routing/recovery parity remains a follow-up.
