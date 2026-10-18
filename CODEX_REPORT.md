# Codex review — `fix/bot-live-reply-reactions` vs `origin/main` (0165d66)

Branch HEAD: `5c80ce6` — "[0.4.2-alpha] review fixes: placeholder can never lose a reply; reaction parity + hygiene"
Previous review: FAIL on `4284f6b` (9 findings). This pass re-checks those nine and hunts regressions.

REVIEW: FAIL

All nine prior findings are genuinely addressed — the reply-loss class is gone (I re-ran the exact
`finish("✅")` / stale-finalize shapes against the real hub and the real Hermes consumer), the tick no
longer hangs a run for `replyWaitMs`, the reaction is applied once on the final to the answered message
with `asEmoji` parity, and the hidden/cleanup/404 items hold. One new defect blocks a pass: `send()`
surrenders **any** text to a pending placeholder before the notice/interim guard, so a send that is not
that turn's answer is written into the tick's message and finalizes that turn. The branch's own
invariant ("only the chat's NEWEST stream can match, so a later turn cannot hijack an old tick") holds
only when the later turn streams.

## Findings

1. **MEDIUM — `hermes-plugin/foxfleet/adapter.py:1790-1792`: a placeholder absorbs a later, unrelated
   `send()` and ends that turn with foreign text.**
   `pending = self._pending_placeholder(...)` (line 1790) runs *before* the notice/interim exclusion on
   line 1793 (`owed = None if (self._notice_send.get() or meta.get("_interim_send")) else ...`). A pending
   tick therefore captures the next `send()` in that chat no matter what it is: `_complete_placeholder`
   edits the tick into that text with `final=true` and returns the tick's id as the delivered message.
   The text is not lost, but it never exists as its own message, the empty turn is finalized with
   someone else's content, and the `_send_notice`/`_dispatch_inline_reply` invariant ("a notice: never
   ends another live answer", adapter.py:1177) is broken for the 300 s `PLACEHOLDER_TTL` window.
   Reproduced with the real hub + real adapter (`python probe_hijack.py`, three chats on one adapter):
   - tick in chat A (non-final `✅`), then `adapter.send(chat, "/status output from a command handler")`
     → `success=True message_id=fm_6Mq1hAjmuo_FcBz_` = the tick's id; transcript
     `['first question', '/status output from a command handler']` — the tick was overwritten, no new
     message.
   - tick in chat B, then a notice-marked send (`_notice_send` set, exactly what
     `_dispatch_inline_reply` does for `/status`, `/help`, `/model`) → same: it replaced the tick
     (`same_as_tick: True`).
   - control, chat C: tick, then a *new stream* (`send_stream_frame("new turn partial", turn_id="turn-d")`),
     then `send("new turn final")` → new id, tick untouched (`[..., '✅', 'new turn partial', 'new turn final']`).
     So the newest-stream rule works only when the later turn seeds a stream; any later send that does
     not (inline command reply, interim notice, a turn for which `send_stream_frame` returned False at
     `MAX_STREAMS`) is hijacked.
   Fix: gate the match the same way the owed path already is, e.g.
   `pending = None if (self._notice_send.get() or meta.get("_interim_send")) else self._pending_placeholder(...)`,
   and re-check `state.placeholder` inside the `async with state.lock` in `_complete_placeholder`
   (the decision is currently taken outside the lock, adapter.py:1523-1527).

2. **LOW — `adapter.py:1523-1537` vs `1539-1552`: `_complete_placeholder` leaves `state.owed` set.**
   A stream can hold both states (a final with text fails → `owed` set with no chunks; a following
   `✅` finalize then takes the placeholder branch, adapter.py:1451-1466). After the placeholder is
   completed, a later `send()` of the owed text matches `_owed_stream`, and `_complete_owed` — seeing
   `finalized` — returns `success` with the old ids and sends nothing. Harmless while that text is
   already on the hub, silent non-delivery if it is not. Clear `owed` in `_complete_placeholder` (as
   `_complete_owed` does), and/or have `_complete_owed` require `state.text() == text` before claiming
   success on a finalized stream.

3. **LOW — `server/bot-api.js:453-458` + `server/bot-store.js:272-276`: hidden filtering happens after
   the page slice, so pagination no longer adds up.** `out.messages = out.messages.filter(...)` after
   `store.transcript(...)` leaves `has_more`/`offset` describing the unfiltered list: a page can return
   fewer than `limit` items while `has_more` is false, and hidden rows inside a page silently shrink it.
   `chats()` does this correctly (filter before slicing, via `vis()`), so the transcript route is the
   odd one; filter inside `transcript()` and compute `has_more` from the visible list.

4. **LOW — `bot-api.js:95-101`: a reaction-only reply keeps the raw `REACT: ❤` directive as visible text
   until its final frame.** `botReactOf` returns `{ text: t }` unchanged for `only && !final`, so the
   cumulative snapshot mid-stream shows `REACT: ❤`, and a reaction-only reply whose final frame never
   arrives keeps the directive in the transcript forever. `server/test/bot-reactions.test.js:73-79`
   codifies this ("kept verbatim"). Now that bot agents advertise `agentReactions` (index.js:383), the
   apps render it; stripping the line without applying the reaction on non-final frames (or applying
   the reaction early and not finalizing) would remove the visible directive.

5. **LOW (doc) — `CHANGELOG.md:21` and `contract/bot-api.md:33-41` overstate the guarantee.** "No reply
   can be lost either way" is true for the native-frame path this branch fixes. Outside it — native
   streaming disabled for a turn because `send_stream_frame` returned False at `MAX_STREAMS`
   (adapter.py:1436-1441) — the empty finalize goes out through `send()`/`edit_message` as an ordinary
   `✅` message and the real text then opens a second message: the pre-branch "tick, then reply" shape.
   Also worth stating: with a placeholder still pending when the next turn starts streaming, the
   recovery text no longer matches (correctly) and the tick stays as a stray `✅` — the accepted cost of
   the newest-stream rule.

## The nine prior findings — re-verified

1. HIGH (lost genuine `✅`/suppressed reply) — **fixed.** The tick is stored non-final
   (`_push_snapshot`, `state.placeholder=True`), so Hermes' recorded payload stays `"✅"` while the
   message is on the hub. Probe with the real consumer, no deltas, `finish("✅")`:
   `delivered_final_matches("✅")=True already_sent=True`, transcript `[user, '✅']`, run still live,
   then ends by idle — exactly one `✅`, nothing suppressed. For a real answer with no deltas,
   `delivered_final_matches(answer)=False`, so the gateway does not suppress and its recovery `send()`
   edits the tick in place (plugin test 1: `result.message_id == tick_id`, `foxfleet.replace` emitted,
   run finished).
2. MEDIUM (run hung for `replyWaitMs`) — **fixed.** The tick is a bot write, so `botActivity` arms
   `replyIdleMs` (bot-api.js:284-288, 312; default 30 s at `bot-api.js:40`). With `replyIdleMs=400` the run ends `done` in <400 ms
   (plugin test 2 and my probe); `replyWaitMs` (300 s) only applies to runs that never wrote.
3. MEDIUM (react on non-final / wrong target) — **fixed.** `botReactOf(v.req.text, v.req.final === true)`
   and `applyBotReact` only on final, `final === true` (bot-api.js:95-140); target is
   `liveRun(...).userMsgId` captured in `startRun` from `postMessages` (bot-api.js:297, 408), with
   `lastUserMessage` only as the agent-initiated fallback. Tests cover mid-stream no-reaction, once-only,
   and "reacts to the answered message, not the mid-turn one".
4. MEDIUM (no `asEmoji` parity) — **fixed.** `botReactOf` uses `replyReaction` (reactions.js:12-17):
   `REACT: ❤` → stored `❤️`; a token that is not an emoji leaves the text untouched and applies
   nothing. Test `bot-reactions.test.js:111`.
5. LOW (preview/`q` leak) — **fixed.** `chats()` takes `hiddenOf` and filters before the preview and
   the `q` match (bot-store.js:261-269); route passes the account's hidden ids (bot-api.js:445-451).
   Test `:119`.
6. LOW (chat delete left rows) — **fixed.** `reactions.remove` on the chat route (bot-api.js:492); test
   `:132` asserts `reactions.json` is empty.
7. LOW (`__proto__` 500s) — **fixed.** `!CHAT_ID.test(parts[4])` → 404 before any store call
   (bot-api.js:444); test `:145` covers `__proto__`, `constructor`, `not-a-chat` on both routes.
8. LOW (contract silent on REACT:) — **fixed.** `contract/bot-api.md` "Reply conventions (0.4.2)".
9. LOW (reaction-only bubble vs `reaction_only`) — **still open, as documented** in the CHANGELOG and
   contract. Consistent with the stated scope.

## Security / identity on the new bot routes (checked)

- Actor is built only from `c.scope`/`c.user` (bot-api.js:465); a body-supplied actor is ignored.
- `message_id` is type/length checked, then required to exist in *that* chat's transcript
  (bot-api.js:467-468) — a cross-chat id is 404 `message_not_found`. The bot store lives under the
  per-account registry dir, so no other account reaches it.
- Emoji is validated by `reactionStore.set` (`validEmoji` → 400 `invalid_emoji`); hidden ids are capped.
- Replayed `message.send` (`out.replayed`) applies no reaction, and `set()` is idempotent.

## Tests run (real counts)

- `node --test --test-timeout=120000 server/test/*.test.js`: **600 tests, 589 pass, 4 fail, 7 skipped**
  (matches `scripts/hub-tests.min` 600). The 4 failures are `cli.test.js:177`,
  `connector-doctor.test.js:15`, `connector-doctor.test.js:30`, `machines.test.js:56`; I extracted a
  pristine `origin/main` tree (`git archive`) and ran those three files there: **23 tests, 19 pass,
  4 fail — identical set.** Baseline (local Hermes checkout present, connector key), not regressions.
- `node --test server/test/bot-reactions.test.js server/test/bot-sessions.test.js`: **18/18 pass**
  (12 in the new file, including the 11 behaviours listed for it).
- `pytest test_stream_placeholder.py`: **4 passed**; whole plugin suite (`pytest` in
  `hermes-plugin/tests`): **193 passed, 1 skipped** (2:12).

## Test gaps

- No test for finding 1: a notice/interim/plain `send()` arriving while a placeholder is pending.
- No test drives a real `run_turn` turn for the #71643 recovery — the plugin test calls
  `adapter.send()` directly, so only the two gateway predicates it depends on
  (`delivered_final_matches`) were verified by reading and by measurement, not end-to-end.
- No test that a `REACT:` token that is *not* an emoji leaves the reply text untouched.

## Positives worth keeping

- `_pending_placeholder` correctly refuses finalised, expired and non-newest streams; `_evictable_stream`
  is unchanged and placeholder streams become idle-evictable after `STREAM_IDLE_EVICT`.
- The placeholder branch only fires on a lone `✅` final with no chunks and no unconfirmed send, so any
  stream that showed content (including a genuine `✅` after deltas) keeps the ordinary final path.
- `_complete_placeholder` reuses `_push_final`, so a replacement longer than one chunk gets the same
  overflow/split handling as any other final, and a rate-limited hub is waited out.
