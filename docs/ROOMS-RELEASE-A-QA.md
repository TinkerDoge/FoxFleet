# Agent rooms Release A: manual QA script

This is the recorded manual canary for **Release A only** (rooms, two agents, Stop, cards, media,
reconnect). The automated fake-model acceptance suite is `server/test/conversation-e2e.test.js`.
This script is how Doge runs **test-SUMI ↔ test-Sora** on an **isolated hub after the flip**.
It is not a production rollout and it does not authorize one.

## Hard stops

- **Do not run this against production** until Doge flips `FOXFLEET_ALLOW_BOTS` and restarts the
  gateway himself. This document never writes that variable and never changes a live profile.
- Use only the isolated hub data directory, port, owner account, profiles and bot tokens listed
  below. Do not point `test-SUMI` or `test-Sora` at production, and do not touch live SUMI/Sora.
- Do not paste bot tokens, owner passwords or profile secrets into git, chat, tickets or logs.
- Do not enable groups on any live profile. Channels (`kind=channel`) are later work.
- Keep the documented hub baseline failures. Do not "fix" the web contrast failure in this pass.

## What must be recorded before starting

| Field | Value |
| --- | --- |
| Operator / date | |
| Release A commit under test | |
| Isolated hub data dir (`FOXFLEET_DATA`) | |
| Isolated hub URL / port | |
| Owner account id | |
| test-SUMI bot agent name / token minted | |
| test-Sora bot agent name / token minted | |
| test-SUMI **pinned** model | |
| test-Sora **pinned** model | |
| Web browser / app build | |
| Android device / app build | |

**Pinned models are required.** Set an explicit model on each test profile and record it above.
Never leave a profile on Auto and never auto-select GLM. If a model cannot be pinned, stop the run.

## Isolated setup

1. Start the hub from the Release A commit with a fresh data directory and a non-production port:
   `FOXFLEET_DATA=<isolated dir> FOXFLEET_PORT=<isolated port> FOXFLEET_BOT_API=1
   FOXFLEET_BOT_AGENTS='test-sumi,test-sora'` (or the exact isolated agent names you use).
   Use `*` only on the isolated hub if the exact names are awkward.
2. Complete owner setup on the isolated hub. Confirm `GET /api/auth` advertises `botApi`.
3. Create two **bot** agents (for example `test-sumi` and `test-sora`) and mint one token for each.
4. Install the same plugin commit into two isolated Hermes profiles, `test-SUMI` and `test-Sora`.
   Put each token only in that profile's private `.env`, set `FOXFLEET_ALLOWED_USERS` to the
   isolated owner id, and point both profiles at the isolated hub URL.
5. Only after Doge's flip and gateway restart: verify each test profile has
   `FOXFLEET_ALLOW_BOTS=mentions` in its isolated profile environment. Do **not** write it from
   this checklist; if it is absent, stop and ask Doge.
6. Restart both isolated gateways. Confirm both bot agents are online and both profiles show the
   pinned model from the table above.
7. Create a room with both test agents. Confirm both see the room and its members.

## Canary checklist

Mark each line pass/fail and attach evidence (message ids, timestamps or screenshots). A failure
stops the run; do not "retry through" a safety failure.

### 1. Single-agent mention

- [ ] From the web app, send `@test-SUMI release A smoke test`.
- [ ] Exactly one agent turn reaches test-SUMI.
- [ ] test-SUMI posts exactly one answer in the room, attributed to test-SUMI.
- [ ] test-Sora receives no turn and posts nothing.
- [ ] Refreshing does not duplicate the answer.

### 2. Structured handoff

- [ ] Send `@test-SUMI hand this to test-Sora and ask for a review`.
- [ ] test-SUMI posts its own answer, then a structured handoff reaches test-Sora in the **same room**.
- [ ] test-Sora posts one review answer attributed to test-Sora.
- [ ] The handoff turn is agent-origin, not a new human message.
- [ ] Ask for a longer chain (Sora → SUMI → Sora). At most four dispatches run for that root.
      A fifth handoff shows the hub's `handoff_limit` notice instead of running silently.
- [ ] A handoff attempted after five minutes is refused with `handoff_expired`; it does not reach
      the target and does not become a late answer.

### 3. Passive text

- [ ] Send plain text with no typed mention: nobody runs.
- [ ] Send a quoted mention (`> @test-SUMI ...`): nobody runs.
- [ ] Send a code-block mention (`` `@test-SUMI` `` or a fenced block): nobody runs.
- [ ] All three messages remain in history and are not answered.

### 4. Duplicate delivery

- [ ] Send one addressed message with a client id, then resend the identical request before the
      first answer completes.
- [ ] The hub returns the same message and only one agent turn runs.
- [ ] The room contains one human request and one agent answer, not two.

### 5. Stop, late output and resume

- [ ] Ask test-SUMI for a slow task and let it start. While it is working, mention test-Sora so
      its turn is queued.
- [ ] Press **Stop** in the room.
- [ ] The queued test-Sora turn is cancelled and never starts.
- [ ] test-SUMI observes the stop. Record whether its status is `stopped` (acknowledged) or
      `uncertain`/`timeout` (not acknowledged); an unacknowledged live turn must **not** be shown
      as successfully stopped.
- [ ] Any late send, edit or handoff from the stopped turn is refused (`dispatch_stale`).
- [ ] The visible partial, if any, is marked interrupted and no late completion is posted.
- [ ] Press **Resume**. The cancelled queued turn does not restart.
- [ ] A fresh mention after Resume starts new work normally.

### 6. Owner cards

- [ ] Ask test-SUMI to raise an approval card for an action.
- [ ] The card opens in the room and the owner queue shows it.
- [ ] A normal text message from the agent (for example `approved`) does not answer the card.
- [ ] A guessed callback id from the agent is refused and does not resolve the card.
- [ ] Only the owner's card tap reaches test-SUMI, and it is the exact card.
- [ ] A second tap on the same card is stale.
- [ ] Stop closes any still-open card; a late card answer is refused.

### 7. Room media

- [ ] Upload a PNG and a ZIP from the web app and send them in a message.
- [ ] test-SUMI and test-Sora (members) download identical bytes.
- [ ] A bot of the same account that is **not** in the room gets 404.
- [ ] Another account gets 404 for the room and its media.
- [ ] Revoke the media as owner. Owner, member bots and any other client now get 404.
- [ ] Re-sending the revoked media id is refused.

### 8. Web and Android reconnect

- [ ] Open the room in web and on Android. Both show the same ordered transcript.
- [ ] Reconnect web (reload/offline toggle): no lost or duplicated messages.
- [ ] Reconnect Android (background/foreground or network toggle): no lost or duplicated messages.
- [ ] Read state and unread counts match the room, not per-agent copies.
- [ ] Stop test-SUMI's isolated gateway, then Stop the room while it is offline. Record the
      `uncertain`/`timeout` status; reconnect the gateway and confirm the old turn does not replay.
- [ ] Restart the isolated hub. Reopen the room; history, members, cards and media grants persist.
- [ ] A 1.1-only client (if one is intentionally left connected) receives no group frames.
      This is not a Release A client path; it is a guard check only.

### 9. Cleanup

- [ ] Stop the isolated hub and both test gateways.
- [ ] Revoke or delete the isolated bot tokens.
- [ ] Remove the isolated data directory only after evidence is saved.
- [ ] Confirm production was not contacted, no live profile changed, and no
      `FOXFLEET_ALLOW_BOTS` value was written by this run.

## What remains manual after the automated gate

The fake-model acceptance suite covers the hub-side room contract, two fake bots, handoff budget,
Stop fencing, authorization, media grants and 1.1 isolation. The following are intentionally not
proven by it:

- Real Hermes profile behavior, real model/tool output, and model-specific handoff choices.
- Real web and Android rendering, navigation, notifications, read/unread state and accessibility.
- Reconnect across real devices, gateways and networks (including TLS/proxy behavior).
- Cross-account isolation in the UI and the operator's production rollout/rollback decisions.

Release A is accepted only when the automated suite is green **and** this isolated canary is
recorded. It does not imply production rollout; Doge owns the production flip separately.
