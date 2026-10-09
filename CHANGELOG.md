# Changelog

All notable changes to Foxfleet. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/) (`0.x` is alpha: breaking changes can happen between releases; `config.json` v3 is the stable part).

## 0.2.0-alpha: easy connect

Android `versionName 0.2.0-alpha`, `versionCode 5`.

### Added

- **Easy onboarding for Hermes.** *Manage › Machines › Connect a machine* (web and Android) makes a 15-minute, single-use pairing code and shows a one-line `curl … | sh` command (plus PowerShell and Node-only variants), a `foxfleet://pair` magic link, a QR of the https link and a live status line (*Waiting for the machine…* → *Found 3 profiles: default, coder, research*).
- **One connector per computer.** `foxfleet-connector` pairs once, discovers Hermes profiles (`~/.hermes`, `profiles/<id>`), lets you choose them (checklist, `--all`, `--profiles a,b`), registers each as an agent and multiplexes them over one outbound WebSocket. `--install-service` for systemd (user), launchd and a Windows scheduled task, with `uninstall-service`.
- **Machines.** `GET/POST /api/machines…` (pairing create/status, redeem, list, rename, revoke, rotate); the hub keeps only a token hash; revoke removes the machine's agents. Manage › Machines lists status, profiles and last seen.
- Dashboard passwords and chat API keys of machine agents are read locally by the connector and never sent to the hub.

### Documentation and legal

- README, docs home and pages use real screenshots of the web and Android apps (rebuild with `design/tools/make-readme-images.py`); the old drawn placeholders and the placeholder funding links are gone.
- Terms of Use, User Agreement and Privacy Policy templates ship with the release (still pending legal review).

### Changed

- **Breaking (alpha):** the per-agent connector token and bootstrap prompt are gone (`connectorToken`, `bootstrap`, `connectorTokenHash`, `HUB_URL`, `FOXFLEET_TOKEN`). Connect machines instead. Hermes agents added by hand are now direct connections only.

## 0.1.0-alpha: first release

Android `versionName 0.1.0-alpha`, `versionCode 3`.

### Added

- **Hub** (Node 22, no runtime dependencies): accounts and a login gate (first-run owner setup, scrypt password hashes, invite or open registration, rotating session tokens, device list with revoke, sign out everywhere, rate limiting and lockout, CSRF/Origin checks); per-user agent registries and write-only secrets; plugin kinds for OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok and Hermes agents; an MCP inbox for bridged agents; QR pairing and invite links; `/api/media-proxy` with SSRF protection; static serving of the web app with SPA fallback, CSP and cache headers.
- **Hermes connector**: outbound-only connection from the agent's machine to the hub, HTTP and WebSocket tunnelling, so chat and screen takeover work without opening ports.
- **Screen takeover** with short-lived tickets, hand-back, a time limit and a visible red border (web) / `FLAG_SECURE` (Android).
- **Web app** (Preact + Vite + TypeScript, installable PWA): streaming chat with sanitised Markdown, reasoning blocks, tool status, image and file attach, `/` and `#` autocomplete, voice input where the browser supports it, media viewer, schema-driven agent management, screen takeover (noVNC), Admin (registration, invites, people, pairing QR), devices and security, settings, accessibility pass.
- **Android app** (`dev.foxfleet.app`, Kotlin + Compose): the same features, QR scan through the Google code scanner, `foxfleet://connect` deep links, multiple hubs.
- **Terms of Use, User Agreement and Privacy Policy** (templates) with an acceptance checkbox on the setup and join screens; the hub records the accepted version and time (`acceptedTerms`).
- **Shared design tokens** (`design/tokens.json`) generating web CSS and the Compose theme.
- **OpenAPI 3.1 contract** (`contract/openapi.json`) with a shared scenario run against the real hub and the web mock.
- **Documentation site** (VitePress, GitHub Pages), Docker and systemd deployment files, `deploy/deploy.sh` (backup, tests, restart, health check, rollback, `--dry-run`).
- **Release tooling**: release signing configuration for the Android app (keystore from environment or an untracked file), a draft release workflow, server tarball with checksums.

### Known limitations

See the roadmap (`docs/roadmap.html`) and `RELEASE_NOTES_0.1.0-alpha.md`.
