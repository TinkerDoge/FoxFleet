# Foxfleet 0.2.0-alpha

**Foxfleet** is a self-hosted hub, web app and Android app for talking to all your AI agents from one calm place. This is the **first alpha**: it works end to end in the maintainers' tests, but it has had little real-world use. Do not expose a hub to the internet without https (a reverse proxy or a Cloudflare Tunnel), and expect rough edges.

## Downloads

| File | What it is |
| --- | --- |
| `foxfleet-0.2.0-alpha.apk` | Android app (`dev.foxfleet.app`, Android 10+), release-signed |
| `foxfleet-server-0.2.0-alpha.tar.gz` | The hub: `server/`, `connector/`, the built web app, `deploy/` files, licence and docs |
| `SHA256SUMS` | Checksums for the files above |

## Verify the download

1. Put the files in one folder and check the hashes (every line should say `OK`):

   ```bash
   sha256sum -c SHA256SUMS
   ```

2. Check the APK's signing certificate (Android build-tools `apksigner`):

   ```bash
   apksigner verify --print-certs foxfleet-0.2.0-alpha.apk
   ```

   The line `Signer #1 certificate SHA-256 digest` must be exactly:

   ```text
   df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df
   ```

   If it differs, do not install the APK.

## Quick start (5 minutes)

```bash
tar xzf foxfleet-server-0.2.0-alpha.tar.gz && cd foxfleet-server-0.2.0-alpha
node server/index.js            # Node 22+, no npm install needed; prints a setup code on first start
```

Open `http://127.0.0.1:3080`, create the owner account with the setup code, then add an agent. Or use Docker (`docker compose up -d --build` from a git checkout), systemd (`deploy/foxfleet.service`) or a Cloudflare Tunnel. Full guides: <https://tinkerdoge.github.io/FoxFleet/>.

Install the APK (allow *Install unknown apps* for your browser or file manager), enter your hub's https address or scan the pairing QR from **Admin → Pair a phone**.

## What is new in 0.2.0

- **Easy connect.** *Manage › Machines › Connect a machine* (web and Android) makes a 15-minute, single-use pairing code and shows one command to paste on the computer (`curl … | sh`, plus PowerShell and Node-only variants), a magic link and a QR. A live status line shows the machine and its profiles arriving.
- **One connector per computer, many Hermes profiles.** `foxfleet-connector` pairs once, finds your Hermes profiles, lets you pick which to share, registers each as an agent and carries them all over one outbound connection. `--install-service` keeps it running after reboots.
- **Safer by design.** The pairing code is exchanged for a machine token (stored in a 0600 file on the computer; the hub keeps only a hash). Dashboard passwords and API keys stay on the machine. Revoke or re-pair a machine from the apps.
- **No more per-agent connector tokens.** This is a **breaking change** from 0.1.0: Hermes agents that used the old per-agent token must be reconnected through *Connect a machine*. Hermes agents added by hand are direct connections only.
- **Android:** a Machines screen and the `foxfleet://pair` link.
- **Docs and README** now use real screenshots; funding placeholders removed; Terms, User Agreement and Privacy Policy templates included.

Upgrading from 0.1.0: the APK is signed with the same key, so it installs over the old app. See [CHANGELOG.md](CHANGELOG.md) and the upgrade guide on the docs site.

## Known limitations

- **The machine connector has been tested against a mock multi-profile Hermes, not a real Hermes installation.** Profile discovery follows Hermes's source, but expect differences. Background-service install is only exercised for the generated unit files; macOS (launchd) and Windows (scheduled task) installs are **untested**.
- **Docker image and compose file have not been built end to end by the maintainers** (no Docker in the build environment); the server was run from the release tarball instead.
- The Android app has been tested with unit and screenshot tests only, **not on a physical device** in this release. R8/minification is off.
- Rate limits key on the socket IP; behind a proxy all clients share one bucket (per-username lockout still works).
- The web app expects to be served by the hub (same origin); a hub on another origin would need CORS (not implemented).
- The QR encoder handles links up to 105 bytes; longer addresses show the link only.
- The Google code scanner needs Play services; without it, type the address.
- The Z.ai Coding Plan and consumer subscription logins are generally **not** allowed for third-party tools: use API keys that your provider's terms allow.
- Terms of Use, User Agreement and Privacy Policy are **templates pending legal review**.

## Changes

See [CHANGELOG.md](CHANGELOG.md). Licence: MIT. Mascot and brand artwork © 2026 Shibe De Doge, included under the MIT licence unless noted. Third-party notices: [NOTICE.md](NOTICE.md).
