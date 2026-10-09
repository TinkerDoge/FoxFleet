# Foxfleet 0.1.0-alpha

**Foxfleet** is a self-hosted hub, web app and Android app for talking to all your AI agents from one calm place. This is the **first alpha**: it works end to end in the maintainers' tests, but it has had little real-world use. Do not expose a hub to the internet without https (a reverse proxy or a Cloudflare Tunnel), and expect rough edges.

## Downloads

| File | What it is |
| --- | --- |
| `foxfleet-0.1.0-alpha.apk` | Android app (`dev.foxfleet.app`, Android 10+), release-signed |
| `foxfleet-server-0.1.0-alpha.tar.gz` | The hub: `server/`, `connector/`, the built web app, `deploy/` files, licence and docs |
| `SHA256SUMS` | Checksums for the files above |

Verify before you install: `sha256sum -c SHA256SUMS`. The APK's signing certificate SHA-256 fingerprint is printed in the release description by the maintainer; check it with `apksigner verify --print-certs foxfleet-0.1.0-alpha.apk`.

## Quick start (5 minutes)

```bash
tar xzf foxfleet-server-0.1.0-alpha.tar.gz && cd foxfleet-server-0.1.0-alpha
node server/index.js            # Node 22+, no npm install needed; prints a setup code on first start
```

Open `http://127.0.0.1:3080`, create the owner account with the setup code, then add an agent. Or use Docker (`docker compose up -d --build` from a git checkout), systemd (`deploy/foxfleet.service`) or a Cloudflare Tunnel. Full guides: <https://tinkerdoge.github.io/FoxFleet/>.

Install the APK (allow *Install unknown apps* for your browser or file manager), enter your hub's https address or scan the pairing QR from **Admin → Pair a phone**.

## Highlights

- Accounts with a login gate, invites, devices and sign-out everywhere.
- Plugins for OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok and Hermes agents; MCP inbox for bridged agents.
- Outbound-only connector for agents on real machines, with screen takeover.
- Web app (installable) and Android app with the same design and features.
- OpenAPI contract, documentation site, Terms/Privacy templates with acceptance on sign-up.

## Known limitations

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
