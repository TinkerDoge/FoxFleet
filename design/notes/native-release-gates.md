# Native Hermes channel: release gates

This is the acceptance checklist for replacing FoxFleet's connector-driven Hermes sessions. It is not a claim that every gate is complete. `contract/bot-api.md` and `hermes-plugin/README.md` describe the implemented wire protocol and adapter guarantees; earlier design notes include future features.

## Architecture (required)

- One normal Hermes gateway owns the FoxFleet platform plugin alongside its other messaging channels. No dashboard password, private TUI child or remote model-provider adapter is needed for native messaging.
- Hub accounts own their bots, chats, transcripts and uploaded media. Hermes owns inference, tools, sessions, slash commands, busy handling and approvals.
- Bot mode is explicitly configured. Offline messages stay durably queued and never fall back to a connector.
- All agent kinds remain Hermes-only. Do not reintroduce GLM, OpenCode, Grok or MCP-inbox integrations while completing this channel. An LLM provider used by a Hermes agent is not a separate agent kind.

## Release gates

### Transport and security
- [ ] Reviewed hub and plugin changes integrated on one branch with machine-readable contract tests.
- [ ] Safe standalone delivery for cron and `send_message`, without evicting any gateway socket.
- [ ] Restart-safe replay/idempotency; contiguous ACKs and fail-closed persistence/admission errors.
- [ ] Account/bot/chat/media ownership, deny-by-default Hermes user authorisation, lifecycle fencing and secret-redaction regression tests.
- [ ] Busy notifications, gateway drain and >64 KiB multi-chunk streaming cannot lose work or prematurely finish the app's reply view.
- [ ] Clarify/approval/confirmation interactions resolve only the intended active request, user, chat and session; stale/forged/replayed choices are refused.
- [ ] Media transfer works without exposing local paths or depending on connector filesystem allowlists.

### User-facing channel
- [ ] Native slash commands dispatch in Hermes, not in a copied allowlist or prompt shim.
- [ ] The app's Stop action actually interrupts Hermes work, rather than merely closing the hub's stream view.
- [ ] Native bot creation, one-time token display, rotation/revocation and profile setup are accessible on phone and desktop. Unknown write outcomes require status readback before a second mutation.
- [ ] Native chats/history, media and interaction cards work in both web and Android.
- [ ] Capabilities reflect actual support; unavailable features fail explicitly rather than appearing to succeed.

### Verification and rollout
- [ ] Pure/fault-injection tests, isolated real hub/adapter tests and full-gateway tests are all independently rerun on the integrated source.
- [ ] Full-gateway smoke exercises the normal Hermes process, plugin discovery, real AIAgent/tool dispatch and persistent sessions. A local scripted provider fixture must be labelled as such, not reported as live-model validation.
- [ ] Full test results include failures/skips/cancellations, with independently reproduced unchanged-baseline failures identified.
- [ ] Signed Android build uses Doge's existing signing identity, with the version incremented and signature verified.
- [ ] Live canary and rollback are explicitly reviewed; only then migrate the remaining agents.
- [ ] Retire connector/TUI/dashboard dependencies only after the native replacements pass the corresponding gate. Never destroy an existing working deployment merely to make the branch look cleaner.

## Current development discipline

The public bot API is feature-gated, default off. Development uses isolated worktrees, ephemeral loopback hubs and scratch Hermes homes. Existing hub/agents remain unchanged until a separate reviewed cutover. Passing an adapter harness is not proof of a complete native channel, and an admission ACK does not guarantee durable inference completion after a gateway crash.
