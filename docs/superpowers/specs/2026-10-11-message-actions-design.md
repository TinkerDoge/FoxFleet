# FoxFleet message actions

Date: 2026-10-11 (Asia/Bangkok)
Status: Design approved by the user on 2026-10-11; spec awaiting review.
Baseline: `5c6aada`, version `0.3.8-alpha`.

## Requested outcome

Long-press a message to get a Telegram/Discord-style menu: react, copy, quote, delete. Let agents react to the user's messages (for example a heart when they like what was said). Double-tap a message to heart it. Borrow other useful messenger and agent-app features.

The user chose, in order:

1. Delete hides the message **for this account only**; the agent keeps its memory of it.
2. Reply carries the quote **in the message text** (a leading `>` line); no stored reply id.
3. Hermes agents react through a **`REACT:` line** in their reply, parsed like `MEDIA:` tags.
4. Extras in this round: **swipe to reply**, **Retry / Edit last**, **Share message**.
5. Quick reactions become exactly **👍 👎 ❤️ 🎉 😮** plus a smiley-plus button that opens the full picker.

## Current evidence

1. Android already long-presses a message frame, but it only opens `EmojiPickerSheet` (`ChatScreen.kt` `MessageRow`, `reactable` modifier). There is no copy, quote or delete action.
2. Web shows reactions through a hover `ReactButton` (`web/src/chat/Message.tsx`); there is no context menu.
3. Quick reactions are `👍 ❤️ 😂 🎉 😮 😢 🙏 🦊` in both `QUICK_REACTIONS` (`android/.../ui/chat/Messenger.kt`) and `QUICK` (`web/src/chat/Reactions.tsx`).
4. Agent reactions exist only for MCP inbox agents (`hub_react` in `server/mcp.js`; `agentReactions: kindOf(m) === 'mcp-inbox'` in `server/index.js`). Hermes agents cannot react.
5. Hermes owns its transcript upstream. The hub can delete a whole Hermes session but not one message, so a real per-message delete is not available for Hermes.
6. The reactions route (`GET/PUT/DELETE /agents/{a}/sessions/{sid}/reactions`) already loads that session's messages for every agent kind to validate ids, and returns `{ actor, messages }`. Clients call it after each turn to reconcile.
7. `reactionStore` (`server/reactions.js`) is per-account and is already cleaned up on session delete, agent delete, account delete and history retention.
8. A local `retry` command already re-sends the last user message (`retryLast` in `web/src/chat/store.ts`; `LocalCommand.Retry` on Android). Hermes ships `/undo` (`server/hermes-commands.json`).
9. The shared tag parser exists three times (`server/media-tags.js`, `web/src/lib/mediaTags.ts`, `android/.../MediaTags.kt`), pinned by `contract/media-tags.vectors.json`. Its `mask()` already ignores code fences, inline code and blockquotes.
10. The agent note lives in `connector/foxfleet-connector.mjs` and is pinned by `contract/agent-note.golden.txt`.
11. Android's chat screen already uses a left-edge swipe to switch agents.

## Design

### 1. Quick reactions

Both apps use the same quick row: `👍 👎 ❤️ 🎉 😮`, followed by a smiley-plus button that opens the full searchable picker (the existing `EmojiPickerSheet` on Android, the existing picker popover on web). The pills' "add reaction" button opens the same picker. The full catalog is unchanged.

### 2. Message menu

**Android.** Long-press (or the TalkBack custom action "Message actions") opens a `ModalBottomSheet`, Discord-style:

- Top: the quick row from section 1.
- Then a list of actions, shown only where they apply:

| Action | Shown on | Behavior |
| --- | --- | --- |
| Reply | all messages | Sets the composer's reply target (section 5). |
| Copy | messages with text | Copies the display text (media tags and directives removed) and shows a "Copied" toast. |
| Select text | messages with text | Opens a dialog with the display text inside a `SelectionContainer`. |
| Share | messages with text | Android share sheet with the display text. |
| Retry | the newest agent reply, when not streaming | Runs the existing local retry. |
| Edit | the newest user message, when the agent's command list has `undo` and nothing is streaming | Sends `/undo`, then puts that message's text (without its reply quote) back in the composer. |
| Delete | all messages | Hides the message for this account (section 6). |

A message without a hub id (still streaming, or not yet reconciled) shows React and Delete disabled. Copy, Select, Reply and Share still work.

The pressed frame keeps its accent outline while the sheet is open.

**Web.** Right-click, or long-press on a touch pointer (500 ms), opens the same actions as a popover anchored at the pointer. Escape or an outside click closes it, and focus returns to the message. The hover bar on each message gets a `⋯` button that opens the same popover, so the keyboard can reach it. Select text is not listed on web, because the browser already selects text. Share uses `navigator.share` where it exists and is hidden elsewhere.

### 3. Double-tap to heart

Double-tapping a message toggles the user's ❤️: it adds the heart, or removes it if the user already has one there. A heart scales in and fades over the frame (about 400 ms; skipped when reduce-motion is on), with a haptic tick on Android.

- Android: `combinedClickable(onDoubleClick = …)` on the frame. Images, links and buttons inside the frame keep their own taps.
- Web: only for `pointerType === 'touch'`, detected as two taps within 300 ms and 24 px. A desktop double-click keeps selecting a word.
- Messages without a hub id ignore the double-tap.

### 4. Swipe to reply (Android)

Dragging a message to the right moves it with the finger, capped at 96 dp, and shows a reply arrow that fades in. Past 64 dp a haptic tick confirms. Releasing past 64 dp sets the reply target; any release springs the message back.

A drag that starts within 24 dp of the screen's left edge is ignored, so the existing edge swipe to switch agents keeps working. Vertical scrolling wins when the drag is mostly vertical (horizontal touch slop is checked first). TalkBack users reach Reply through the menu.

### 5. Reply (quote in the text)

Choosing Reply shows a chip above the composer: an accent bar, the author ("You" or the agent's name), a one-line excerpt, and an ✕ to cancel. Sending with a reply target produces this text:

```text
> <excerpt>

<the user's text>
```

- The excerpt is the quoted message's display text, with whitespace collapsed to single spaces, cut to 140 characters with `…`.
- A quoted message that has no text uses `[image]`, `[file]` or `[voice]` instead.
- The reply target clears after sending, when switching chat, and on ✕.
- Composer drafts and queued messages carry the final text, so nothing else changes.

**Rendering.** In both apps, a **user** message whose text starts with one `> ` line followed by a blank line draws that line as a reply bubble. The bubble has an accent bar and the excerpt in muted text, above the rest of the message. Agent messages keep normal Markdown blockquotes. The quote is part of the text, so the agent, history, search and other clients all see the same content.

### 6. Delete = hide for this account

`reactionStore` gains a hidden-message list beside its reaction rows (file version 2; version 1 files load with an empty list). The same `remove`, `retain` and `clear` calls cover both, so every existing cleanup path also cleans hidden ids.

- New methods: `hide(agent, session, message, present)` and `hidden(agent, session) -> string[]`. Limits: 5,000 hidden ids per session, and 50,000 hidden ids in the store.
- New route: `PUT` and `DELETE /agents/{a}/sessions/{sid}/hidden` with body `{ message_id }`. It validates the message the same way the reactions route does (the id must exist in that session's messages). It answers with the same snapshot shape as the reactions route.
- The reactions snapshot gains `hidden: string[]`, limited to ids still in the session. Older clients ignore it.
- Clients drop hidden ids from the rendered transcript, on every device of that account.
- After hiding, a snackbar (Android) or toast (web) offers **Undo** for 5 seconds; Undo sends the `DELETE`.
- If the request fails, the message comes back and the existing reaction error text explains why.
- `contract/openapi.json` documents the route and the new field.

### 7. Hermes agents react: the `REACT:` line

**Grammar.** A `REACT:` directive is one line that contains only optional spaces, `REACT:`, optional spaces, one RGI emoji, and optional spaces (`^[ \t]*REACT:[ \t]*(<emoji>)[ \t]*$`, multiline). Lines inside code fences, inline code or blockquotes are ignored, because `mask()` blanks them. A line with anything else on it is plain text. The emoji check uses the same rule as `validEmoji`.

**Parser.** `parseMedia` removes every valid `REACT:` line from `text`, and returns `react: <emoji> | null`: the first valid line's emoji. Later lines are removed but not applied. All three implementations change together; `contract/media-tags.vectors.json` gains cases for:

- a plain directive
- a skin-tone emoji
- a ZWJ emoji
- a directive inside a fence (kept as text)
- an inline mention (kept as text)
- two directives (first wins, both removed)
- a non-emoji value (kept as text)
- a reply made only of a directive

While a reply streams, a partial `REACT:` line is hidden by the existing streaming parser path (`parseStreaming`).

**Hub.** The reactions route derives agent reactions **on read**; nothing is written to the store. For each assistant message whose parsed `react` is set, the reaction goes on the nearest earlier user message that has an id. The actor is `{ id: 'agent:' + name, name: label || name, kind: 'agent' }`, the same identity `hub_react` uses. These derived reactions merge into the snapshot's groups with the stored ones, and an actor never counts twice for the same emoji. Because they come from the transcript, they survive restarts, show on every device, and disappear with the history. The user cannot remove an agent's reaction; tapping that pill adds or removes only the user's own.

`agentReactions` becomes true for Hermes agents (the agents that receive the connector's agent note) as well as `mcp-inbox`. Other kinds parse `REACT:` the same way, but they are not told about it, so they do not advertise the capability.

**Clients.** An assistant message whose display text is empty after parsing, and which has no media, reasoning or request cards, does not render a row. Its reaction still shows on the user's message.

**Agent note.** One line is added to the connector's agent note, and the golden file and note hash are updated:

```text
To react to the user's message, put REACT: ❤️ (any one emoji) on its own line. Use it sparingly.
```

The connector version is bumped, because the note changed.

### Amendments made while planning

- **Edit** is offered on Hermes agents (`kind === 'hermes'`); the bundled Hermes catalog always has `/undo` with availability `chat`.
- **React and Delete** are left out of the menu (not greyed) until the message has a hub id; the menu never shows a control that cannot work.
- **Undo after hiding** is an inline status row at the bottom of the transcript ("Message hidden · Undo", 5 s), like the existing reaction-error line. Neither app has a toast/snackbar system and this round does not add one.
- **Copy** gives no extra toast: Android 13+ shows its own clipboard confirmation, and on web the menu closing is the feedback.
- **`REACT:` grammar** (same in all three parsers): a line that is optional spaces/tabs, `REACT:`, optional spaces/tabs, a token of 1–32 UTF-16 units with no space, tab, CR or LF, optional spaces/tabs. The token must be *emoji-shaped*: no ASCII letters, and at least one code point ≥ U+2000. Emoji-shaped lines are removed from view; the hub applies the reaction only when the token also passes `validEmoji` (one RGI emoji). `parseMedia` returns the first emoji-shaped token as `react`.
- **Delete** on the menu reads "Delete for me".

## Out of scope

Stored reply ids and jump-to-original, real per-message deletion, multi-select, message pins, forking, notification quick reply, text-to-speech, and an MCP `hub_react` for Hermes. Each can be its own later round.

## Error handling

- React and hide are optimistic, with a rollback on failure, the same as reactions today. Errors use the existing `reactionError` line.
- Edit: if `/undo` fails or the agent refuses it, the composer is not filled, and the failure shows as a notice.
- Copy, Share and Select never touch the network.
- A `REACT:` line whose token is not emoji-shaped (for example `REACT: like`) stays visible as text. An emoji-shaped token that is not one RGI emoji is removed from view but not applied.

## Testing

- **Hub** (`server/test`):
  - Hidden store: idempotent hide and unhide, limits, version 1 to version 2 load, cleanup through `remove`, `retain` and `clear`.
  - Hidden route: access, unknown id gives 404, snapshot `hidden`.
  - REACT derivation: nearest earlier user message, first directive wins, merge with stored reactions without duplicates, no store writes.
  - `agentReactions` capability.
  - Agent-note golden.
  - Minimum test count raised from 290.
- **Contract:** new `media-tags` vectors pass in all three parsers.
- **Web** (`web/tests`): quote building and excerpt rules, reply-bubble detection, menu actions shown per message, touch double-tap detection (and a mouse double-click does not heart), hidden ids filtered, Undo.
- **Android** (`android/app/src/test`): quote building, reply-bubble detection, the swipe rule (threshold, edge exclusion, vertical wins), action visibility, a hidden filter; a Robolectric screenshot of the menu sheet in light and dark.
- **Manual / device (recorded separately):** long-press, double-tap and swipe on a phone; TalkBack actions; a live Hermes agent reacting with `REACT:`; two clients seeing the same hide.
