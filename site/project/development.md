# Development

## Repository layout

```text
server/        the hub (Node 22, no dependencies): index.js, config.js (kinds), accounts.js, connector.js,
               hermes.js, openai.js, mcp.js, inbox.js, screen.js, media-proxy.js, qr.js, ws.js  +  test/
connector/     foxfleet-connector.mjs (served by the hub at /connector.mjs)
web/           Preact + Vite + TypeScript app (src/, tests/, public/, tools/mock-hub.mjs)
android/       Kotlin + Jetpack Compose app (app/src/main/java/dev/foxfleet/app/…)
contract/      openapi.json, validate.mjs (tiny validator), run.mjs (shared scenario)
design/        tokens.json, tools/ (gen-tokens, gen-notice, make-wordmarks), brand/ (mascot, wordmarks)
deploy/        Dockerfile companions, systemd unit, deploy.sh, env.example, Cloudflare tunnel notes
docs/          in-repo Markdown (ARCHITECTURE, CONNECT-AGENT, INSTALL, ACCESSIBILITY), roadmap.html, images
site/          this documentation site (VitePress)
.github/       workflows: server, web, android, secrets (gitleaks); docs (Pages) when enabled
```

## Run the tests

```bash
npm test                      # hub: node --test server/test/*.test.js (includes the contract test)
cd web && npm ci && npm test  # web: vitest (client, markdown sanitizer, images, commands, a11y contrast, service worker, contract)
cd android && ./gradlew testDebugUnitTest   # Android unit and Roborazzi screenshot tests (JDK 17 + Android SDK)
```

## Build

```bash
cd web && npm run build                 # tokens → tsc --noEmit → vite build → web/dist (served by the hub)
cd android && ./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

## Run it locally with hot reload

```bash
node server/index.js                      # hub on 127.0.0.1:3080
cd web && npm run dev                      # Vite dev server, proxies /api, /health, /connector.mjs to the hub
FOXFLEET_DEV_HUB=http://127.0.0.1:3080 npm run dev   # (that is the default)
node web/tools/mock-hub.mjs 3099           # or: a mock hub (no agents needed) used for screenshots
```

## Code style

- No formatter is enforced. Match the surrounding style: ES modules, 2-space indent, small functions, comments explain *why*.
- The hub stays dependency-free; web dependencies are few on purpose (`preact`, `marked`, `dompurify`; noVNC is vendored and lazy-loaded).
- User-visible strings in the web app go through i18n (`src/i18n/en.json`); Android strings live in the Compose code today.
- Error messages from the hub may reach users: no hosts, URLs or secrets.

## Generated files

`web/src/styles/tokens.css` and `android/.../ui/Tokens.kt` come from `design/tokens.json`; `NOTICE.md` from `design/tools/gen-notice.mjs`. `npm run tokens:check` fails if they are stale.

## This documentation site

```bash
cd site && npm ci && npm run dev      # live preview at http://localhost:5173/FoxFleet/
npm run build                          # generates api/env/errors/roadmap pages, then builds .vitepress/dist
npm run check-links                    # verify every internal link and asset in the built site
```
