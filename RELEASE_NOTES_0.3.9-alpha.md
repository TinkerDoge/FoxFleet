# Foxfleet 0.3.9-alpha

**Foxfleet** is a self-hosted hub, web app and Android app for talking to all your AI agents from one calm place. This is an **alpha pre-release**: it works end to end in the maintainers' tests, but it has had little real-world use, and the features below still need a live check on real installations. Do not expose a hub to the internet without https (a reverse proxy or a Cloudflare Tunnel), and expect rough edges.

0.3.9-alpha is the first public release since 0.3.3-alpha. It rolls up six internal alpha builds (0.3.4 to 0.3.9): a Telegram-style agent list, screen, media and scroll fixes, agents that know they are in FoxFleet, reasoning and pictures, reactions and tool activity, and message actions (menu, double-tap heart, swipe to reply, delete for me).

## Downloads

| File | What it is |
| --- | --- |
| `foxfleet-0.3.9-alpha.apk` | Android app (`dev.foxfleet.app`, Android 10+, versionCode 17), release-signed |
| `foxfleet-server-0.3.9-alpha.tar.gz` | The hub: `server/`, `connector/`, the built web app, `deploy/` files, the `skills/` folder (the `foxfleet` Hermes skill), licence and docs (including `docs/AGENT-AWARENESS.md`) |
| `SHA256SUMS` | Checksums for the two files above |
| `APK-CERT-SHA256.txt` | The expected APK signing certificate fingerprint |

There is no debug APK in this release.

## Verify the download

1. Put the files in one folder and check the hashes (every line should say `OK`):

   ```bash
   sha256sum -c SHA256SUMS
   ```

2. Check the APK's signing certificate (Android build-tools `apksigner`):

   ```bash
   apksigner verify --print-certs foxfleet-0.3.9-alpha.apk
   ```

   The line `Signer #1 certificate SHA-256 digest` must be exactly:

   ```text
   df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df
   ```

   If it differs, do not install the APK. It is the same key as every earlier release, so it installs over them.

## Upgrade notes

- **Hub first.** Redeploy the hub from the server bundle (or rebuild your Docker image), then update the connectors, then the apps. New hub features (hidden messages, reactions, activity, screen error codes) need the new hub; the apps tell you when the hub is older.
- **Connectors need updating** (`foxfleet-connector` 0.3.9-alpha, from the same bundle) for agent awareness (`source: "foxfleet"`), pictures you send, shared media folders and the `REACT:` line.
- **Agent note (`doctor --fix`).** The connector can write a short note for the agent into each Hermes profile's `config.yaml` (`platform_hints.foxfleet`) so the agent knows it is in FoxFleet, how `MEDIA:` files work and that `REACT:` exists. It only does this **after you agree**: run `foxfleet-connector doctor --fix` (it asks first; `--yes` skips the question). A backup is kept once (`config.yaml.foxfleet.bak`); `agent-note remove` takes it out; `agentNote: false` turns it off. If you decline, the same note is sent once with the first message of each new chat.
- **Agent note is shorter** (658 to 481 bytes: the core `MEDIA:` and `REACT:` syntax, this machine's folders, size limit, upload folder and a pointer to the skill). A note you installed earlier shows as *stale* in `agent-note status` until you run `agent-note install`; with `agentNote: true` the connector updates it by itself.
- **The `foxfleet` skill is new** (`skills/foxfleet/SKILL.md` in the server bundle). It holds the full chat rules (files, reactions, reply quotes, question cards, remote slash commands, common mistakes) so they cost nothing on ordinary turns. **The connector and `doctor --fix` do not install the skill for you yet.** To teach an agent, upload `SKILL.md` in a FoxFleet chat and ask it to copy the file to `~/.hermes/skills/communication/foxfleet/SKILL.md` (for another Hermes profile: `<profile home>/skills/communication/foxfleet/`), then run `skills_list`; the exact message is in `docs/AGENT-AWARENESS.md`. Without the skill the note still works; agents just know less.
- **Mixed versions.** Apps 0.3.8 and older show `REACT:` lines as raw text. A new connector on an old hub loses agent reactions. Downgrading the hub to 0.3.8 drops the hidden-message list on its next write of `reactions.json`.
- **Android.** Install the APK (allow installs from your browser or file manager for this one file). It is an alpha pre-release; the debug build `dev.foxfleet.app.debug` is separate and installs side by side. Reactions artwork (Twemoji) is bundled in the app, so there is no CDN call.
- See [CHANGELOG.md](CHANGELOG.md) and the docs site: <https://tinkerdoge.github.io/FoxFleet/>.

## Quick start (5 minutes)

```bash
tar xzf foxfleet-server-0.3.9-alpha.tar.gz && cd foxfleet-server-0.3.9-alpha
node server/index.js            # Node 22+, no npm install needed; prints a setup code on first start
```

Open `http://127.0.0.1:3080`, create the owner account with the setup code, then add an agent. Or use Docker, systemd (`deploy/foxfleet.service`) or a Cloudflare Tunnel. Full guides: <https://tinkerdoge.github.io/FoxFleet/>.

## What is new since 0.3.3-alpha

### 0.3.4-alpha: agent list and polish
- A Telegram-style agent list on web and Android: pinned agents first, then newest activity, one-line preview, time, unread dot, *Typing...* and *Needs approval*, search, pin and unpin (swipe or long-press on Android). The hub adds per-account activity and pins (`PUT /api/agents/{name}/pin`).
- Motion tokens, message entry animation, typing indicator, skeleton rows, softer message cards, an Android settings refresh, and several web layout fixes.

### 0.3.5-alpha: screen, media and scroll fixes
- **Bot computer view:** longer cold start (up to 90 s), named error messages instead of a blank viewer, touch controls (tap, long-press, drag, scroll, pinch zoom, key row with sticky Ctrl/Alt/Shift), `hub.version` and `hub.features` in `GET /api/auth`.
- **Media from agents:** tool-made media (image generation, screenshots, files a tool wrote) reaches the chat even without a tag; failed cards say why and offer a copyable fix; connector 0.3.5 shares each profile's cache folders and has `allow-media`.
- Agent cards get time and preview for Hermes agents; chat scroll opens at the newest message, with a go-to-bottom arrow and a *New message* pill.

### 0.3.6-alpha: agent awareness, pictures, reasoning
- Agents know they are in FoxFleet (`source: "foxfleet"`, with the opt-in note described above).
- Pictures you attach now reach native Hermes agents; Android pictures get a spinner, Retry and a fallback to the embedded copy.
- The computer view tells an empty remote desktop from a failure, with **Restart desktop** and **Reconnect**, plus on-screen diagnostics.
- A collapsed **Reasoning** block above replies (Settings > *Show reasoning*).
- `npm test` now guards the hub test count (`scripts/check-hub-tests.mjs`).

### 0.3.7-alpha: reactions, tool activity, cleaner history
- Emoji reactions on any message (quick row plus a searchable catalog with skin tones), stored per account; agents react through `hub_react`. Twemoji artwork bundled (CC BY 4.0, credited in the picker and `NOTICE.md`).
- Temporary tool-activity lines ("Searching the web", "Running a command"), no more "Used N tools" logs in finished answers.
- Android: an account-scoped media cache (256 MB) with a **Clear cached media** button; videos download when opened. Warmer dark palette.

### 0.3.8-alpha: one frame per message
- Each message is one card holding reasoning, text, pictures, files, time and reactions. History no longer shows Hermes' own notices as your messages, and skill turns show as you typed them. The agent note is about half as long.

### 0.3.9-alpha: message actions
- A message menu (long-press on Android, right-click, long-press or the ⋯ button on web): quick reactions, Reply, Copy, Select text (Android), Share, Retry, Edit (Hermes agents, via `/undo`) and **Delete for me** (hides a message from your own view, keeps it in the agent's history, synced across your devices).
- Double-tap a message to heart it (touch), swipe right to reply (Android), reply bubbles with a "Replying to" chip.
- Hermes agents can react by writing `REACT: <emoji>` on its own line; the hub shows it as the agent's reaction and never shows the line.
- A shorter agent note and the new `foxfleet` skill (see the upgrade notes above); the server bundle now includes `skills/` and `docs/AGENT-AWARENESS.md`.

### Fixed
- Hub: a connector link that closed while its forwarder servers were still being created left them listening, which kept the process alive (this hung the `ui-gateway` test file on Node 22 in CI). The link now closes late forwarders; a regression test covers it.

## Things to verify live

These are covered by automated tests, but not yet by long real-world use. Reports are welcome.

1. **Hub redeploy** from this bundle works, and an old app against the new hub (and the reverse) shows the "update" hints instead of failing.
2. **Message menu, double-tap heart, swipe to reply, quote replies** on a real phone and in a browser; **Delete for me** and Undo, and that hidden messages stay hidden on a second device.
3. **Edit** (`/undo`) and **Retry** with a real Hermes agent; **`REACT:`** from a real Hermes agent after `doctor --fix`.
4. **Agent list:** order, previews, times, pins, unread and *Needs approval* with real agents.
5. **Bot computer view** on a phone, including **Restart desktop** and the touch controls (not verified on a phone yet).
6. **Pictures you send** reach a native Hermes agent; tool-made pictures, video, voice and files appear as cards.
7. **Reasoning, tool-activity lines and reactions** with real models; the Android media cache and **Clear cached media**.
8. **Install over an older release** (same signing key) keeps your sign-in and data.

## Known limitations

- Hermes native chat controls have been tested against a protocol-faithful fake and by hand against one real gateway version, not broadly.
- The Android app has been tested with unit and screenshot tests, **not broadly on physical devices**. R8/minification is off.
- Edit and Retry work only with Hermes agents; a message queued in a native Hermes session cannot be taken back.
- Background-service install is only exercised for the generated unit files; macOS (launchd) and Windows (scheduled task) installs are **untested**. The Docker image and compose file have not been built end to end by the maintainers.
- Rate limits key on the socket IP; behind a proxy all clients share one bucket.
- Terms of Use, User Agreement and Privacy Policy are **templates pending legal review**.

## Changes

See [CHANGELOG.md](CHANGELOG.md). Licence: MIT. Mascot and brand artwork © 2026 Shibe De Doge, included under the MIT licence unless noted. Third-party notices (including Twemoji, CC BY 4.0): [NOTICE.md](NOTICE.md).
