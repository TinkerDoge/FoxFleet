# Changelog

All notable changes to Foxfleet. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/) (`0.x` is alpha: breaking changes can happen between releases; `config.json` v3 is the stable part).

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
