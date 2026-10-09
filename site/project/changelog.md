# Changelog

Foxfleet follows the version in `android/app/build.gradle.kts` (`versionName`) and the repository's root `package.json`. It is alpha: breaking changes can happen between `0.x` releases. `config.json` v3 is the stable part.

## Unreleased

- Documentation site (this site), built with VitePress and published to GitHub Pages.
- README: connector command fixed to the environment-variable form; setup-code note corrected for loopback binds.

## 0.1.1-alpha (Android `versionCode 2`)

- **Web app** reaches parity with Android: streaming chat with Markdown (marked + DOMPurify), reasoning blocks, tool status, image attach with client-side downscale, file upload with progress, voice (Web Speech where available), `/` and `#` autocomplete, media viewer, schema-driven agent management, screen takeover (noVNC), Admin (registration, invites, people, pairing QR), devices and security, settings.
- **PWA** shell service worker (never caches `/api`), versioned update prompt.
- **Accessibility** pass (skip link, focus management, labelled controls, live regions, token contrast tests); checklist in `docs/ACCESSIBILITY.md`.
- **Hub:** `/api/media-proxy` with SSRF protection; CSP keeps `img-src 'self' data: blob:`.
- **Contract:** OpenAPI 3.1 spec and shared contract tests (real hub and web mock).
- **Docs/legal:** `NOTICE.md` generated from real dependency metadata; wordmark tool takes its font from the environment; stricter `.gitignore`.
- **Deploy:** `deploy/deploy.sh --dry-run`.

## 0.1.0-alpha (Android `versionCode 1`)

- New name and clean open-source repository (MIT). Package `dev.foxfleet.app`, `foxfleet://connect` deep link.
- Shared design tokens (`design/tokens.json`) generating web CSS and Android Compose theme.
- Web scaffold (Preact + Vite + TypeScript): first-launch hub address, sign-in, setup, join. Hub serves `web/dist` with SPA fallback, CSP and cache headers.

## Before the rename (AgentsHub, private)

| Version | Highlights |
| --- | --- |
| 0.1 | Web Mission Control for Hermes agents; zero-dependency hub. |
| 0.2 | First Android app: calm light/dark look, streaming chat. |
| 0.3 | Markdown, images, media viewer, slash commands and skills, voice, avatars. |
| 0.4 | File attach (90 MB streamed), screen takeover, MCP inbox, OpenAI-compatible bridge. |
| 0.5 | Data-driven agent registry, write-only secrets, privacy contract, wooden-fox brand. |
| 1.0-alpha1 | Plugins and config v3, accounts and login gate, first-launch hub address, Hermes connector. |
| 1.0-alpha2 | Connector screen tunnel, QR pairing, Admin screen, scrubbed hosts, v1 deploy script. |
