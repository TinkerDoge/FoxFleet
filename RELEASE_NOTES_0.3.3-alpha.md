# Foxfleet 0.3.3-alpha

**Foxfleet** is a self-hosted hub, web app and Android app for talking to all your AI agents from one calm place. This is an **alpha pre-release**: it works end to end in the maintainers' tests, but it has had little real-world use, and the resilience and media features below still need a live check on real installations. Do not expose a hub to the internet without https (a reverse proxy or a Cloudflare Tunnel), and expect rough edges.

0.3.3-alpha follows 0.3.2-alpha: sessions now survive short network and Cloudflare outages, agents can send pictures, video, voice messages and files with `MEDIA:` tags, and the Android debug build installs next to the release app.

## Downloads

| File | What it is |
| --- | --- |
| `foxfleet-0.3.3-alpha.apk` | Android app (`dev.foxfleet.app`, Android 10+, versionCode 11), release-signed |
| `foxfleet-server-0.3.3-alpha.tar.gz` | The hub: `server/`, `connector/`, the built web app, `deploy/` files, licence and docs |
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
   apksigner verify --print-certs foxfleet-0.3.3-alpha.apk
   ```

   The line `Signer #1 certificate SHA-256 digest` must be exactly:

   ```text
   df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df
   ```

   If it differs, do not install the APK. It is the same key as 0.1.0-alpha, 0.2.0-alpha and 0.3.2-alpha, so it installs over those versions.

## Upgrade notes (hubs)

- **The hub (server) and the machine connector need to be redeployed.** The resilience fixes live in the hub, the connector and both apps, and `MEDIA:` tags need the hub and the connector on the computer that runs the agent. Update the hub first (or together with the apps), then restart the connectors.
- New endpoints: `POST /api/agents/{name}/media`, `GET /api/media/{token}` and `GET /health/stream` (see `contract/openapi.json`). `foxfleet doctor` now uses `/health/stream` to check that your public address does not buffer streaming responses.
- Behind a Cloudflare Tunnel or other proxy, see the recommended settings: <https://tinkerdoge.github.io/FoxFleet/hosting/cloudflare-tunnel#resilience>.
- Upgrade the apps and hub together. See [CHANGELOG.md](CHANGELOG.md) and the docs site: <https://tinkerdoge.github.io/FoxFleet/>.

## Quick start (5 minutes)

```bash
tar xzf foxfleet-server-0.3.3-alpha.tar.gz && cd foxfleet-server-0.3.3-alpha
node server/index.js            # Node 22+, no npm install needed; prints a setup code on first start
```

Open `http://127.0.0.1:3080`, create the owner account with the setup code, then add an agent. Or use Docker, systemd (`deploy/foxfleet.service`) or a Cloudflare Tunnel. Full guides: <https://tinkerdoge.github.io/FoxFleet/>.

## What is new in 0.3.3-alpha

### Sessions survive short outages (Cloudflare blips)

- **Sign-out only on a real 401.** Web and Android now ask `/api/auth` before treating a 401 as a lost session; "cannot tell" counts as transient. 502/503/504/52x responses, timeouts and resets never sign anyone out and never fail a run.
- **Retry and resume.** Idempotent GETs retry with exponential backoff and jitter, and event streams resume from the cursor for about three minutes. A small **Reconnecting...** line replaces error banners, including at app start.
- **A send cut off by a blip is found or resent once** with the same `client_id`, so the hub never runs it twice.
- **Hub and connector:** event streams carry a `retry` hint, the connector reconnects after a failed handshake (a tunnel answering 502 to the upgrade used to leave a machine dead until restart), uses jittered backoff and a silence watchdog for half-open links, and the hub re-attaches live native sessions and back-fills missed events when a machine reconnects.
- Tested with a fault-injecting proxy (502 storms, resets, frozen links) in front of the hub for web, hub, connector and Android.

### Pictures, video, voice and files from agents (`MEDIA:` tags)

- Tags such as `MEDIA:/path/file.png` or `MEDIA:https://...` (optionally with `[[audio_as_voice]]`) are removed from the text and shown as image, video, audio (voice) and file cards on web and Android, with a fullscreen viewer for pictures and video. Tags inside code blocks are ignored, and tags never show in reasoning blocks.
- Local files are fetched by the connector only from its shared folders, with an extension allowlist and content check, a 25 MB cap and a rate limit, and served to the owning user only through a signed link that expires in 15 minutes. Remote URLs go through the SSRF-guarded fetcher. See <https://tinkerdoge.github.io/FoxFleet/apps/agent-media>.

### Debug and release builds install side by side (Android)

- The debug build is now `dev.foxfleet.app.debug`, labelled **FoxFleet Debug**, with a DEBUG-badged icon. The release build stays `dev.foxfleet.app` / **FoxFleet**. They keep separate data and sign-in. Both register `foxfleet://` links, so Android may ask which app should open a link.

## Things to verify live

These are covered by automated tests, but not yet by long real-world use. Reports are welcome.

1. **Resume after a network or Cloudflare blip mid-run:** start a longer agent run, cut the connection briefly (airplane mode or a tunnel restart), and check that you stay signed in, see Reconnecting, and the reply continues without a duplicate message.
2. **`MEDIA:` tags** render as cards for an image, a video, a voice message and a file, on web and Android, with a real Hermes agent.
3. **Side-by-side install:** FoxFleet and FoxFleet Debug install together with separate sign-ins.
4. **Pairing deep link:** opening a `foxfleet://` pairing link with both apps installed asks which app to use, and the chosen app pairs correctly.

## Known limitations

- **Hermes native chat controls have been tested against a protocol-faithful fake and by hand against one real gateway version, not broadly.** Expect differences on other Hermes versions.
- The Android app has been tested with unit and screenshot tests, **not broadly on physical devices**. R8/minification is off.
- A message queued in a native Hermes session cannot be taken back (Hermes owns the queue).
- Background-service install is only exercised for the generated unit files; macOS (launchd) and Windows (scheduled task) installs are **untested**. The Docker image and compose file have not been built end to end by the maintainers.
- Rate limits key on the socket IP; behind a proxy all clients share one bucket.
- The Z.ai Coding Plan and consumer subscription logins are generally **not** allowed for third-party tools: use API keys that your provider's terms allow.
- Terms of Use, User Agreement and Privacy Policy are **templates pending legal review**.

## Changes

See [CHANGELOG.md](CHANGELOG.md). Licence: MIT. Mascot and brand artwork © 2026 Shibe De Doge, included under the MIT licence unless noted. Third-party notices: [NOTICE.md](NOTICE.md).
