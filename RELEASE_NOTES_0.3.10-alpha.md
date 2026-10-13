# Foxfleet 0.3.10-alpha

**Foxfleet** is a self-hosted hub, web app and Android app for talking to all your AI agents from one calm place. This is an **alpha pre-release**: it works end to end in the maintainers' tests, but it has had little real-world use, and the features below still need a live check on real installations. Do not expose a hub to the internet without https (a reverse proxy or a Cloudflare Tunnel), and expect rough edges.

0.3.10-alpha adds notifications (hub phase 1 and an Android notification service), per-chat backgrounds on web and Android, a slightly lighter dark theme, a header that fits narrow phones, a fixed bot screen viewer and a fixed model picker.

## Downloads

| File | What it is |
| --- | --- |
| `foxfleet-0.3.10-alpha.apk` | Android app (`dev.foxfleet.app`, Android 10+, versionCode 20), release-signed |
| `foxfleet-server-0.3.10-alpha.tar.gz` | The hub: `server/`, `connector/`, the built web app, `deploy/` files, the `skills/` folder (the `foxfleet` Hermes skill), licence and docs (including `docs/AGENT-AWARENESS.md`) |
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
   apksigner verify --print-certs foxfleet-0.3.10-alpha.apk
   ```

   The line `Signer #1 certificate SHA-256 digest` must be exactly:

   ```text
   df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df
   ```

   If it differs, do not install the APK. It is the same key as every earlier release, so it installs over them.

## Upgrade notes

- **Hub first.** Redeploy the hub from the server bundle (or rebuild your Docker image), then update the connectors, then the apps. Notifications need the new hub (`hub.features` lists `notify`); against an older hub the apps show "too old" and hide the notification controls. The hub keeps a new per-account file, `notify.json` (mode 0600), next to its other data; nothing to migrate.
- **Connectors** (`foxfleet-connector` 0.3.10-alpha, from the same bundle) are needed for the model picker fix: the connector now relays Hermes' confirmation for guarded models. An older connector keeps the old behaviour (the pick silently does nothing).
- **Android.** Install the APK over 0.3.9-alpha (same key; your sign-in and data stay). Notifications are off until you turn them on in **Settings > Notifications**; on Android 13+ the app explains and then asks for the notification permission. The app now declares `ACCESS_NETWORK_STATE` (normal permission, no prompt) so the notification service can reconnect when the network returns. Some phones stop background services to save battery; Settings links to the system battery settings (the app does not ask for an exemption).
- **Chat backgrounds stay on the device.** Nothing is uploaded to the hub; signing out keeps them, signing in as another account or on another hub clears them.
- See [CHANGELOG.md](CHANGELOG.md) and the docs site: <https://tinkerdoge.github.io/FoxFleet/>.

## Quick start (5 minutes)

```bash
tar xzf foxfleet-server-0.3.10-alpha.tar.gz && cd foxfleet-server-0.3.10-alpha
node server/index.js            # Node 22+, no npm install needed; prints a setup code on first start
```

Open `http://127.0.0.1:3080`, create the owner account with the setup code, then add an agent. Or use Docker, systemd (`deploy/foxfleet.service`) or a Cloudflare Tunnel. Full guides: <https://tinkerdoge.github.io/FoxFleet/>.

## What is new since 0.3.9-alpha

### Notifications
- **Hub (phase 1):** a per-account event log (newest 500, ids only, never message text) with `reply_finished`, `approval` and `error` events, a resumable stream (`GET /api/notify/stream`, server-sent events with `Last-Event-ID`), catch-up, a master switch, per-agent and per-chat mutes and a test event. Signing out or revoking a device closes its streams; bursts are rate-limited (approvals never dropped); writes are retried and flushed on shutdown. See [docs/notifications-api.md](docs/notifications-api.md) in the repository.
- **Android:** a foreground service holds the stream open with backoff and resume, three channels (Replies, Approvals and questions, Errors) plus a quiet "Connected" line, one notification per chat that opens that exact chat, "Mute 1 h" on every notification, no message text on the lock screen, per-category switches and mutes in Settings, a test button and restart after reboot only when you turned it on.
- **Web:** a small Notifications card in Settings (master switch, agent mutes, test). The web app shows no alerts itself.

### Chat backgrounds and UI polish
- **Per-chat backgrounds** on web and Android: Default, 10 theme-aware colours, 10 patterns or your own picture with Blur and Dim. Kept on the device only.
- **Lighter dark theme** (background `#110F0E` to `#181514`, surfaces follow) and icons on the attachment menu (photo, camera, file).
- **Narrow phones:** under 400 dp wide (or with large text) the chat header moves Screen, Background and History into a **More** menu so the agent name has room; the status line no longer wraps.

### Fixed
- **Model picker:** picking a model that Hermes guards never switched (Android even said it did). Web and Android now show a **Switch anyway** step; a typed `/model X` opens the same card.
- **Bot screen viewer (Android):** the viewer showed black while diagnostics said `blank:false`. It now judges the canvas as actually displayed (`collapsed`, `clipped`, `black`), re-fits itself, and the bundled `viewmetrics.js` adds richer diagnostics (`verdict`, `canvas`, `visible`, `fixes` and more).

### Tests and build
- Android unit tests run in forked JVMs (1 GB heap, new fork every 8 classes), which stops the Robolectric exit-134 aborts; new tests for notifications, backgrounds, the narrow header and a DOM-level screen viewer test in headless Chrome.
- The hub test-count guard is now 349.

## Things to verify live

These are covered by automated tests, but not yet by long real-world use. Reports are welcome.

1. **Hub redeploy** from this bundle works, and an old app against the new hub (and the reverse) shows the "update" hints instead of failing.
2. **Android notifications** on a real phone over hours: reconnect after network changes and sleep, resume without duplicates, approvals arriving while a chat is muted, tap-to-open from a cold start, restart after reboot, behaviour under the phone's battery saver.
3. **Sign-out and account switch** stop the service and clear notifications; "Log in again" after an expired session.
4. **Chat backgrounds** with large and transparent pictures, both themes, and after sign-out and sign-in.
5. **Model picker** with a real Hermes agent and a guarded (expensive) model.
6. **Bot computer view** on several phones and screen sizes (the viewer fix is not yet confirmed broadly on real phones).
7. **Narrow-phone header** and the More menu with large font settings.
8. **Install over 0.3.9-alpha** (same signing key) keeps your sign-in and data.

## Known limitations

- Hermes native chat controls have been tested against a protocol-faithful fake and by hand against one real gateway version, not broadly.
- The Android app has been tested with unit and screenshot tests, **not broadly on physical devices**. R8/minification is off.
- Edit and Retry work only with Hermes agents; a message queued in a native Hermes session cannot be taken back.
- Background-service install is only exercised for the generated unit files; macOS (launchd) and Windows (scheduled task) installs are **untested**. The Docker image and compose file have not been built end to end by the maintainers.
- Rate limits key on the socket IP; behind a proxy all clients share one bucket.
- Terms of Use, User Agreement and Privacy Policy are **templates pending legal review**.

## Changes

See [CHANGELOG.md](CHANGELOG.md). Licence: MIT. Mascot and brand artwork © 2026 Shibe De Doge, included under the MIT licence unless noted. Third-party notices (including Twemoji, CC BY 4.0): [NOTICE.md](NOTICE.md).
