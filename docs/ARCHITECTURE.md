# Architecture

## Pieces

- **Hub (`server/`)**: one Node process, no runtime dependencies. It owns accounts, per-user agent registries, secrets, sessions, and talks to agents. Every client request is authenticated (cookie for the web app, bearer token for Android) and runs inside a per-user context (`AsyncLocalStorage`), so each user sees only their own agents, files, inbox and screens.
- **Clients**: the Android app (Compose) and the web app (Preact). They only see *names, status and capabilities*; hosts, URLs and keys are write-only on the hub (privacy contract, tested).
- **Connector (`connector/`)**: one tiny script per computer that pairs once with a short-lived code, discovers its Hermes profiles, and dials the hub over ONE WebSocket with a per-machine token (hash only on the hub); every frame names its agent. The hub opens loopback forwarders and tunnels HTTP and WebSocket traffic through that single outbound link, so agents need no open ports or public name.
- **Design tokens (`design/tokens.json`)**: colours, radii, type and motion; a script generates the web CSS variables and the Android `Tokens.kt`.

## Agent kinds (plugins)

Each kind is declared in `server/config.js` (`KIND_SPECS`): fields, auth methods, warnings, conditional fields, and a runtime. Clients render add/edit forms from `GET /api/agent-kinds`, so a new kind needs no client change.

| Kind | How the hub reaches it |
| --- | --- |
| `hermes` | Machine connector (default; credentials stay on the machine) or direct host/port (advanced): chat, sessions, files, skills, screen |
| `mcp-inbox` | Mailbox for an outside agent that calls the hub's `/mcp` with a bearer token |
| `openai`, `openrouter`, `zai`, `opencode`, `grok` | API-key chat providers; the hub calls the provider |

Config is versioned (`config.json` v3). Older files migrate on start and a `.bak` is kept.

## Accounts and sessions

scrypt password hashes; first-run owner setup (one-time code on non-loopback binds); registration `closed | invite | open`; sessions are rotating tokens with a device list (revoke, sign out everywhere); per-username lockout plus an IP throttle; CSRF/Origin checks on cookie sessions; TOTP is planned.

## Screen takeover

`/api/agents/{name}/screen/*`: status, start, observe (mints a single-use 30 s ticket), takeover and hand-back (lease with auto hand-back), and a WebSocket relay that splices the viewer to the agent's VNC session. In connector mode the WebSocket is tunnelled through the connector link. The Android window is `FLAG_SECURE` while the screen is open.

## Web serving

The hub serves `web/dist` (override with `FOXFLEET_WEB_DIR`): hashed assets under `/assets/` are immutable, the shell and manifest revalidate, extension-less paths fall back to `index.html`, and the shell carries a strict CSP (same-origin scripts only, no inline script, `frame-ancestors 'none'`).

## Where to look

`server/index.js` (routes, auth, static), `server/accounts.js`, `server/config.js` (kinds, validation), `server/connector.js` and `connector/foxfleet-connector.mjs`, `server/screen.js`, `android/app/src/main/java/dev/foxfleet/app/`, `web/src/`.

## Remote images in Markdown: the media proxy

Agent replies can contain `![](https://…)`. The browser never loads those directly: the web client rewrites them to
`/api/media-proxy?url=…` and the hub fetches the image. Reasons: the page CSP stays `img-src 'self' data: blob:` (no `https:`
wildcard that would let injected markup beacon to any server), and readers' IPs, cookies and referrers never reach third parties.

Hub-side protections (`server/media-proxy.js`, covered by `server/test/media-proxy.test.js`): `https` only, port 443 only, no
credentials in the URL; the host is resolved by the hub and refused unless **every** address is globally routable (loopback,
RFC 1918, CGNAT, link-local incl. cloud metadata, multicast, ULA, mapped/NAT64/6to4/documentation ranges are blocked); the socket is
pinned to the validated address (no DNS rebinding) with SNI and `Host` of the original name; redirects are followed at most twice and
every hop is re-validated; only PNG/JPEG/GIF/WebP/AVIF (never SVG or HTML); 8 MB cap; 10 s total timeout; no cookies are forwarded;
the response is re-served with `nosniff`, a sandboxing CSP and `Cache-Control: private`. A session is required (the route sits behind the login gate).

## Screen takeover in the browser

`Screen` (agents with `capabilities.screen`) lazy-loads noVNC (a separate ~180 kB chunk, only fetched on this view), asks the hub for a
single-use 30-second ticket (`POST …/screen/observe`) and connects to `wss://<hub>/api/agents/<id>/screen/ws?ticket=…`. The view is
view-only until **Take over**; control shows a red border and a countdown to the automatic hand-back, and ends on **Hand back**, at the
deadline, when the view is left, and on `pagehide` (a `keepalive` request). A keys row (Esc, Tab, Enter, arrows, Ctrl+Alt+Del, soft keyboard on touch) is shown while in control.

## Contract

`contract/openapi.json` (OpenAPI 3.1) is the API contract shared by the hub, the web app and the Android app. `contract/run.mjs` is one
scenario that drives any base URL and validates every response against the spec; it runs against the real hub (`server/test/contract.test.js`)
and against the web mock hub (`web/tests/contract.test.ts`), so the mock cannot drift from the server. Operations that need a live agent
(sessions, chat stream, files, screen) are documented in the spec but not yet exercised by the scenario.

## PWA

`web/public/sw.js` caches the app shell only. It never touches `/api`, `/health`, `/mcp`, `/connector.mjs`, pairing pages, non-GET, cross-origin or
range requests. Each build stamps a content-derived version; a new worker waits and the app shows "A new version is ready · Reload"
(no silent swap, so a half-typed message is never lost). Offline, navigations fall back to the cached shell.

## Native Hermes sessions and the facade

```
phone / browser ──► /chat /messages /queue /runs/*  (unchanged shapes)
                         │ capabilities.nativeUi ?
                         ├── no  → coordinator + HTTP runs / chat completions (Grok, OpenAI-compatible, MCP inbox: as before)
                         └── yes → native-facade.js ──► hermes-ui.js (journal, ownership, foxfleet.native/1 events)
                                                           │ ui-call / ui-ev over the existing connector tunnel
                                                           ▼
                                              connector: HermesGateway (one stdio tui_gateway per profile, allowlisted ops)
```

- **One owner.** Hermes owns the session, its queue and its turns; the hub keeps an admission journal (what was sent, what Hermes answered) and an event log with cursors. Any number of viewers (phone, browser, second device) follow the same owner; a viewer going away never cancels anything.
- **The facade** (`server/native-facade.js`) maps the old client entry points onto that owner. A turn becomes a *run* in the usual registry so resume (`Last-Event-ID`), Stop (`/runs/{id}/stop`, which asks Hermes to interrupt and reports the real end) and detach all behave as for other agents. The hub never drains a queue on a native session; it would otherwise double-schedule what Hermes already queues.
- **Extra SSE events:** `foxfleet.request` (card), `foxfleet.request_closed` (answered / cancelled / interrupted), `foxfleet.ack` (Hermes's answer to a message).
- **Profile vs chat.** The model is per conversation (`setmodel`, never `--global`). Hermes's busy-input default is **profile-wide**: it is exposed only as an explicit, confirmed profile setting (`/native/busy`), never as a per-chat toggle.
- **Fallback order** (probed per agent): native UI gateway → HTTP `/v1/runs` → chat completions.

### Validation map (`docs/HERMES-CHAT-CONTROLS.md`, "Validation required")

| Item | Where it is tested |
| --- | --- |
| `/busy ` choices, `/busy st`, aliases, free-text skills | `web/tests/chat-controls.test.tsx`, `android …/ChatControlsTest.kt` |
| Busy message reaches the hub and stays visible while the reply streams | `web/tests/chat-controls.test.tsx`, `server/test/native-facade.test.js` (busy messages) |
| Native busy input reports steered / redirected / queued as Hermes answered it | `native-facade.test.js`, `native-hub.test.js`, `NativeChatTest.kt` (ack labels), `web/tests/native-chat.test.tsx` |
| Order across reconnects and two devices; restart reconciles without loss or duplicates | `native-facade.test.js` (order), `native-hub.test.js` (reconnect, restart, uncertain → reconciled) |
| Approval / clarification: render, answer once, cancel by id, back after reconnect | `native-facade.test.js` (cards), `web/tests/native-chat.test.tsx`, `NativeChatTest.kt` |
| Second device attaches to the same owner; disconnect does not cancel another viewer | `native-facade.test.js` (stop / viewers), `native-hub.test.js` (multi-viewer), `NativeChatTest.kt` |
| Late steer as `pending_steer` replayed once; 409 keeps the text | HTTP fallback: `server/test/chat-controls.test.js`, `web/tests/chat-controls.test.tsx` |
| Interrupt & send waits for termination; failed cancel never starts a second writer | `server/test/chat-controls.test.js`, `native-facade.test.js` (stop) |
| Stop during creation / tool / approval wait is truthful | `native-facade.test.js` (stop right after creation, stop while a card is open) |
| Old stream callbacks cannot overwrite the active session | `web/tests/native-chat.test.tsx` (stale streams), `web/tests/chat-controls.test.tsx` |
| Wrong user/profile fails; unsupported commands and Steer stay unavailable | `native-hub.test.js` (ownership), `ui-gateway.test.js` (allowlist), `ChatControlsTest.kt` |
| Detach keeps work alive, cursor replay and truncation recovery | `native-facade.test.js`, `server/test/runs.test.js` |
| Live Hermes UI-protocol check; HTTP fallback check | `HERMES_REAL_GATEWAY_TEST=…` runs the same suites against a real gateway (see the file header); HTTP fallback in `server/test/chat-controls.test.js` |
