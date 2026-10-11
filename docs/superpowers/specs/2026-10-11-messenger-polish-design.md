# FoxFleet messenger improvements

Date: 2026-10-11 (Asia/Bangkok)
Status: Approved by the user on 2026-10-11; implementation in progress.
Baseline: `17dda79`, version `0.3.6-alpha`.
Branch: `codex/messenger-polish`.

## Requested outcome

Make Android media faster when returning to a conversation. Let humans and agents react to messages with emoji. Show compact, temporary tool activity, leaving the conversation clean after completion. Refresh web and Android together.

The user selected **polished messenger: warmer FoxFleet colors, softer cards, compact chat**. This selects the visual direction; the behavior and architecture below remain a proposed design.

## Current evidence

These findings come from current source inspection, not live-device timing or a fresh browser audit. The user explicitly identified repository example images as outdated; they are excluded from the assessment and must not guide implementation.

1. Android already uses Coil through `MainActivity.kt`. Simply enabling an image library cache does not address the full loading path.
2. `server/media.js` creates signed media URLs containing a new expiry timestamp on resolution. Android media cards use those URLs as image models, so subsequent resolutions can produce different cache identities for the same attachment.
3. `MediaCards.kt` resolves a media reference and calls `host.diagnose` before rendering. Reopening a card can therefore wait for network checks even when image bytes were loaded before.
4. `ChatImage.kt` overrides cache keys with `$model#$attempt`; the fullscreen viewer uses the raw URL. The same picture can have different cache identities between thumbnail, retry, and fullscreen paths.
5. `MediaViewer.kt` builds an ExoPlayer using an OkHttp data source, with no persistent media cache configured there.
6. `ImageEncoder.kt` already writes outgoing image copies into `cacheDir/attachments`. There is no durable reconciliation here between that local file and a subsequently loaded history attachment.
7. Bot Screen is a live noVNC WebView. Its `screen.js` includes regular canvas sampling for blank-screen detection. Disk caching chat attachments does not address live-screen latency. Sampling overhead is a measurement hypothesis, not a proven cause.
8. `server/hermes-ui.js` normalizes tool start/end IDs, but `server/native-facade.js` reduces start/progress to a label and omits tool-end status from the compatibility stream, except for produced media. Both client stream interfaces expose only `onTool(label)`.
9. Both clients render stored tool details. Their current live tool lists cannot reliably represent overlapping tools or distinguish completion by call ID.
10. `web/src/lib/chat.ts` does not preserve history message IDs. `server/history.js` stores API-agent messages without IDs. `server/transcript.js` preserves some native IDs while merging assistant steps. Reliable reactions require stable message identity first.

11. `ChatScreen.kt` falls back to an outgoing image's data URL when its local file is missing, but its click handler still opens the local file URI. A visible thumbnail can therefore open a broken fullscreen image. The viewer must use the same resolved source as the thumbnail.
12. Current `web/src/styles/polish.css` already adds soft assistant cards, grouped bubble corners, a single composer focus ring, and a disappearing completed status. `main.tsx` imports this after `app.css`. Preserve and refine these features rather than proposing them as missing.
13. Current Android `ChatScreen.kt` renders live status in both the header and streaming message. The web header instead shows online/offline state. Consolidate activity without losing connection status.
14. Android `FleetScreen.kt` already has agent search, message-preview matching, pinned-row behavior, and ready counts. Web `Shell.tsx` uses `AgentList` with pin support. Do not replace these with a design inferred from old screenshots.

## Approaches considered

| Approach | Benefit | Cost or limitation |
| --- | --- | --- |
| Scoped messenger upgrade (recommended) | Directly addresses all four requests using existing clients, hub, and shared tokens | Requires coordinated message identity and event changes |
| Cache and styling only | Smaller first delivery | Leaves agent reactions and accurate tool completion unresolved |
| Full offline conversation database and messenger redesign | Broad offline browsing and organization | Larger migration, synchronization, and testing scope than requested |

Deliver the recommended approach in four reviewable batches: media, tool activity, reactions, visual polish. Keep contracts additive so older clients remain usable.

## 1. Android media storage

Introduce one account-scoped media repository shared by chat cards, thumbnails, and fullscreen viewers. Store bytes in app-private storage with an index and a proposed 256 MiB total budget. Evict least-recently-used completed files; exclude active writes and playback. Expose used space and a clear-cache action in Settings.

Use a stable, hashed attachment identity containing hub, authenticated account, agent, session/message attachment identity, and source reference. Never use a signed delivery token as the persistent identity. Existing native messages must first retain their stable source IDs; where those IDs are absent, the hub provides persistent mappings rather than client list positions. Include a content version or digest where available. A source path alone is not immutable; attachment instances in different messages must not overwrite one another.

Loading flow:

1. Check for a completed local copy and show it immediately, without resolving or diagnosing the server URL.
2. For a miss, resolve an authorized delivery URL and fetch on an I/O dispatcher. Deduplicate concurrent requests for the same attachment.
3. Stream to a temporary file with a size limit, validate completion, and publish atomically. Partial downloads must never become valid cache entries.
4. Decode images at their display size. Use the same attachment identity when opening fullscreen.
5. Run delivery diagnostics after an actual failure, preserving current actionable error messages and retry behavior.

Copy outgoing media into the repository before sending. Reconcile the copy with the acknowledged attachment/message identity; never match solely by filename or timestamp. Retry refreshes the delivery URL without creating another cache identity. Thumbnail and fullscreen must share the same local/data-URL fallback when a file has been removed.

Images cache when viewed. Videos download/cache when opened, with visible progress and cancellation; do not automatically download every video in a session. Fully cached videos reopen locally. Existing upload capability limits remain explicit; caching does not imply a new arbitrary-video upload feature.

Namespace storage by hub and account. Logout and account removal clear that account's private copies and decoded image memory. Hub/account switches must never expose another account's files. Clear-cache and eviction must preserve active playback safely. Local media availability does not promise offline transcript loading.

Bot Screen: measure time to first frame, frame pacing, input latency, and canvas sampling overhead on the target Android device. Apply only evidence-backed rendering or lifecycle changes. Preserve view-only/control boundaries, hand-back behavior, and secure-screen protection.

## 2. Temporary tool activity

Carry tool lifecycle information through the hub compatibility stream: turn ID, call ID, tool name, start/progress/end, and failure state only when the upstream supplies it. Keep the old progress label event for compatibility. Replay/resume must be idempotent.

Each client keeps active calls by run and call ID. Render a compact strip below the streaming answer: a simple icon and one safe, short description per active call. Examples: search icon with “Searching the web”, file icon with “Reading a file”, terminal icon with “Running a command”. Unknown tools use a neutral icon and readable name. Do not display raw arguments, paths, credentials, or tool-result JSON as descriptions.

Remove a call when its end event arrives. Clear activity on turn completion, cancellation, error, or session change. Concurrent calls remain separate. Legacy providers that only emit labels show the latest known activity until turn completion; do not invent per-call completion or success.

Completed/history messages contain answer text and media, with no tool-log rows or empty tool-only bubbles. Existing reasoning controls remain separate. Keep tool data internally for diagnostics. Questions, permission requests, failures requiring action, and produced media remain visible in their existing user-facing components.

## 3. Human and agent reactions

Persist reactions at the hub, scoped by account/conversation, agent, stable message ID, emoji, and authenticated actor. Preserve native message IDs and define a canonical ID for merged assistant turns. Assign persisted IDs to API-agent history, including a one-time migration of existing records. Never address messages by page offset, current array index, or text alone. Reconcile optimistic/live IDs with stored IDs before allowing reactions.

Support multiple emoji per person per message. Each actor can add a given emoji once and remove their own reaction. Display emoji/count pills below messages; selected reactions show the user's state. A participant list identifies human versus agent. Use idempotent add/remove operations rather than a network-level toggle, so retries cannot undo the intended action.

Web uses an accessible message action and searchable emoji popover. Android uses long-press plus an accessible action and bottom-sheet picker. Offer a short quick row and the full supported Unicode emoji catalog, including skin tones and joined sequences. Store Unicode values, not artwork URLs. Preserve unsupported future emoji as native text instead of dropping them.

Use a pinned, locally bundled [Twemoji](https://github.com/jdecked/twemoji) asset release for consistent, friendly artwork. The upstream lists MIT for code and CC BY 4.0 for graphics. Include its graphics license, copyright notice, and attribution in both apps. Avoid a runtime CDN dependency. Pick the exact release and record checksums during implementation.

Agent reactions require an explicit, scoped connector/native capability and a documented agent-callable action. Bind the actor to the authenticated agent; never accept arbitrary actor IDs from clients. Provide message IDs to the agent through structured context and return clear unsupported-capability errors. Reaction events update both clients without adding chat messages or triggering another model turn. Do not simulate agent reactions when the agent cannot perform the action.

Optimistic changes roll back on failure. Reload/reconnect fetches authoritative state and deduplicates events. Session deletion, retention expiry, and account deletion remove associated reactions. Tests cover stable identity across pagination, repeated identical messages, merged assistant steps, streaming completion, and restart.

## 4. Shared visual refresh

Keep the selected warm FoxFleet identity: warm neutral canvas, ember accents, soft surface contrast, and compact spacing. Extend `design/tokens.json` and regenerate platform tokens.

Refine current chat, agent/fleet rows, session lists, composer, media cards, reaction controls, and activity strip together. Preserve the web's existing soft assistant cards and grouped bubbles; align Android where useful. Strengthen agent identity and selected-state contrast, unify media framing and reaction spacing, and keep timestamps quiet. Keep long answers readable and code/table areas wide enough to use. Consolidate duplicate live activity labels into one useful location. Preserve existing search, previews, pins, and ready counts.

Avoid decorative motion that delays input or makes Android heavier. Keep reduced-motion behavior, dark mode, configurable accent colors, keyboard focus, screen-reader labels, and comfortable touch targets. Use empty states and conversation previews to make the app feel welcoming and easier to resume.

## Verification and acceptance

- Media: repeated opening and simulated process restart reuse completed bytes; rotated signed URLs do not cause redownloads; thumbnail and fullscreen share identity and missing-file fallback; clear/eviction works; corrupt and partial files recover; account separation holds.
- Performance: record cold versus warm media display times and request counts. A warm hit makes zero media resolution, diagnosis, or download requests. Device timing remains pending until measured on Android.
- Video: downloaded videos replay without network; cancellation and missing/corrupt cache entries recover with a useful state.
- Bot Screen: compare first-frame and frame/input latency before and after any change on the same device/network. No performance claim from unit tests alone.
- Activity: overlapping calls, tool end before reply end, duplicate/replayed events, stop, failure, reconnect, and session switching cannot leave stale rows. Completed history has no tool bubbles.
- Reactions: persistence across hub/client restart, two-client synchronization, human and actual agent writes, Unicode sequences, duplicate requests, rollback, authorization, retention, and message-ID migration.
- Visuals: fresh desktop, narrow mobile, light/dark screenshots for web and Compose; check long names, long answers, media, empty states, large text, keyboard navigation, contrast, and reduced motion.
- Run appropriate hub, contract, web, and Android tests plus web production build and Android build. Physical-device, TalkBack, IME, and live-agent acceptance remain separate from automated proof.

## Review boundary

The source investigation and selected style support this proposal. No app behavior has changed yet. Review this design before implementation under the brainstorming skill's explicit design gate.
