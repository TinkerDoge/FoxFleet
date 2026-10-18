# Codex review — `fix/bot-live-reply-reactions` vs `origin/main` (0165d66)

Branch HEAD: `4284f6b` — "[0.4.2-alpha] bot path: no ✅ placeholder reply, reactions work (agent REACT: + user), capability set"

REVIEW: FAIL

The intended behaviour is real and the happy path works (verified against the real hub and the real Hermes
stream consumer). But the placeholder swallow reports a final as delivered when it sent nothing, and Hermes'
own delivery accounting then suppresses the reply whenever the real answer is exactly the placeholder — a
silent reply loss introduced by this branch. Two reaction-targeting defects and three smaller gaps follow.

## Findings

1. **HIGH — `hermes-plugin/foxfleet/adapter.py:1444-1455`: a genuine `✅` reply is silently lost.**
   The branch returns `True` for a final frame it deliberately did not send. Hermes marks a native finalize
   delivered *before* asking the adapter (`stream_consumer_transport.py:383-397`: `_mark_final_delivered(record=text)`,
   then `_already_sent = True; _last_sent_text = text`), so after the swallow the consumer records
   `_delivered_final_text = "✅"` and claims the turn's final was delivered. If the completed response is itself
   `"✅"` (or normalises to it), `run_turn._run_agent_mark_streamed_delivery` (run_turn.py:2072-2140) asks
   `delivered_final_matches("✅")`, gets `True`, sets `already_sent`, and the normal final send is suppressed —
   the hub never receives anything.
   This is reachable in production: short replies are held during interim ticks by the `_MIN_NEW_MSG_CHARS`
   guard (stream_consumer_transport.py:342, with the default cursor `" ▉"`), so a one-token answer can reach a
   finalize with zero chunks.
   Evidence (real hub + real consumer, no deltas, `finish("✅")`):
   `final_response_sent=True final_content_delivered=True delivered_final_text='✅' already_sent=True
   delivered_final_matches('✅')=True`, hub transcript `[('user', …)]` — nothing else. The new test
   "scoped to streams that showed nothing" sends `"partial answer"` first, so it never exercises this path.
   Same class: any final whose display payload normalises to the placeholder, and a final whose display payload
   is empty (e.g. a directive-only body) is suppressed through the `None`/legacy-trust path.

2. **MEDIUM — `adapter.py:1444-1455`: genuinely empty turns now leave the hub run open for `replyWaitMs`.**
   Tool-only turns and intentional-silence replies finalize with the placeholder; nothing is sent and
   `run_turn` returns early on the `"(empty)"` sentinel, so the bot run gets no terminal event. The hub ends it
   only on its idle timer (`server/bot-api.js:40` `replyWaitMs: 300_000`). Probe: 1 s after `consumer.finish("")`
   the run is still `state: 'running'` with no message. Previously the bare `✅` frame ended the run immediately.
   Anything that derives "working" from the open run now waits up to 5 minutes. No test covers the run state.

3. **MEDIUM — `server/bot-api.js:95-100,124,136` + `server/bot-store.js:257`: the reaction is applied on every
   frame and always to the newest user message.**
   The comment/CHANGELOG say the emoji lands "on final frames"; `botReactOf` returns `react` whenever the
   stripped text is non-empty, and `dispatch` calls `applyBotReact` without checking `final`. The target is
   `lastUserMessage()` at commit time, not the message being answered (`req.reply_to`), unlike the non-bot path
   which anchors on `ledger.userBefore(...)`.
   Evidence: an interim (`final:false`) frame already stored the agent's 🖤 on the user message; after a second
   user message arrived mid-reply, the final frame put the same 🖤 on the *second* question too — one answer
   reacted to two different user messages. A cumulative snapshot that cuts a ZWJ sequence (`REACT: 🙅` then
   `REACT: 🙅‍♀️`) can likewise leave two stored emoji from the same reply.

4. **MEDIUM — `bot-api.js:95-100`: bare symbol emoji are stripped and the reaction silently dropped.**
   The non-bot path normalises through `asEmoji` (`server/reactions.js:10-11`, appending U+FE0F). The bot path
   passes the raw token to `reactions.set`, which validates with `/^\p{RGI_Emoji}$/v`; `"❤"` (U+2764 alone) fails,
   `"❤️"` passes. The 400 is caught by `applyBotReact`'s `catch {}`, so the reply loses the line and no reaction
   is stored. Probe: `REACT: ❤\nGood night` → stored text `"Good night"`, reaction snapshot `{}`.

5. **LOW — `bot-api.js:445-446` + `bot-store.js:259-263`: "delete for me" leaks through the chat list.**
   Hidden ids are filtered only from the paged `/messages` response. `chats()` still builds `preview` from the
   last stored message and `q` still matches hidden text. Probe after hiding the bot reply: `/messages` correctly
   drops it, but `/sessions` reports `preview: "the secret reply text"` and `/sessions?q=secret` still returns the
   chat. Same-account only (the reactions store is per account), but the feature visibly does not hold. Pagination
   is otherwise safe: clients advance `offset` by page size, not by the returned count.

6. **LOW — `bot-api.js:482`: deleting a bot chat leaves its reaction/hidden rows behind.**
   The non-bot route removes them (`index.js:1129` `reactions.remove`); the bot `DELETE sessions/{id}` does not.
   Probe: after a 200 delete, `reactions.json` still held both reaction rows and the hidden row for the dead chat
   id. Reaction rows expire after 90 days, hidden rows never do (only capped), and the stale ids keep matching
   `hidden()` lookups.

7. **LOW — `bot-api.js:453-454`: session id is not validated like the non-bot route.**
   Non-bot uses `sessionId(parts[4])`; the bot route passes the raw segment to `botStore`. `__proto__` and
   `constructor` resolve on the plain-object `chats`/`messages` maps and throw inside `transcript`
   (`list.length`/`list.slice` on `Object.prototype`), answering 500 "Hub request failed" instead of 404.
   Probe: 500 for `/messages`, `/reactions`, `/hidden` on both ids; unknown ordinary ids 404 correctly.
   Pre-existing for `/messages`, extended to the two new routes. No write or prototype pollution observed.

8. **LOW — `contract/bot-api.md:30`: the REACT: contract is undocumented.**
   The table gains `/reactions` and `/hidden`, but nothing tells a bot author that a `REACT: <emoji>` line in
   `message.send`/`message.edit` is stripped from the stored text and applied to the user's message — a
   behaviour that mutates what the bot wrote. "Content: text only" reads as no interpretation. CHANGELOG only.

9. **LOW (design) — `bot-api.js:95-100`: a reaction-only reply is stored as a bare emoji message.**
   Non-bot agents keep the text and set `reaction_only`, which the apps hide; bot chats store `"👀"` as message
   text and the bot `/messages` route never emits `reaction_only`, so the app shows an emoji bubble next to the
   reaction. Deliberate (it gives the run a message to end on) but it is a visible agent-parity divergence and
   should be stated as such, not just implied by a test assertion.

## Tests run (real counts)

- `node --test --test-timeout=120000 server/test/*.test.js`: **594 tests, 583 pass, 4 fail, 7 skipped** (matches
  `scripts/hub-tests.min` 594).
  The 4 failures are `cli.test.js:177`, `connector-doctor.test.js:15`, `connector-doctor.test.js:30`,
  `machines.test.js:56`. I reproduced the same 4 on an `origin/main` (0165d66) worktree — baseline, not
  regressions.
- `node --test server/test/bot-reactions.test.js server/test/bot-sessions.test.js`: **12/12 pass**.
- `pytest test_stream_placeholder.py`: **3 passed**; with `test_transport.py test_stream_fallback.py
  test_native_lifecycle.py`: **99 passed**.

## Verified positives

- The core mechanism works for its intended case: placeholder swallowed, no `✅` message stored, the hub run
  stays open, and a following `adapter.send(..., notify=True)` is streamed into that run (plugin test, plus the
  run-state probe). The recovery send is only suppressed when the final text matches the recorded `"✅"` (finding 1).
- Identity: the actor is built from `c.scope`/`c.user` only (`bot-api.js:455`); a body-supplied `actor` is
  ignored (probe: stored actor was the authenticated `user:<scope>`).
- Message ids: type/length validated and required to exist in *that* chat's transcript; a message id from another
  of the same user's chats answers 404 `message_not_found` (probe). The bot store itself lives under the per-user
  registry dir (`bot-api.js:50`), so another account cannot reach it.
- Replays: the same `idempotency_key` returns `replayed: true` and does not apply the reaction twice (probe).
- `capabilities.reactions/agentReactions` true is consistent with the routes that now exist; the updated
  `bot-sessions` expectation matches the real view.

## Test gaps

- No test for a `"✅"`-only final with zero chunks (finding 1); the "scoped to streams that showed nothing" test
  actually sends content first, so its name is misleading.
- No test for the empty/tool-only turn's run state (finding 2).
- No test for a `final:false` frame carrying `REACT:` + content, or for a user message arriving mid-reply
  (finding 3).
- No test for a bare-symbol emoji (`❤`) or for `asEmoji` parity (finding 4).
- No test that `chats()` preview/`q` exclude hidden text (finding 5), or that deleting a chat clears reactions
  (finding 6), or for malformed session ids (finding 7).
- No test that a body-supplied `actor` is ignored, that cross-chat message ids are refused, or that a replay
  applies the reaction once — the security properties I verified by probe are unguarded.
