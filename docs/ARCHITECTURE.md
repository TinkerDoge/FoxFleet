# Architecture

## Pieces

- **Hub (`server/`)**: one Node process, no runtime dependencies. It owns accounts, per-user agent registries, secrets, sessions, and talks to agents. Every client request is authenticated (cookie for the web app, bearer token for Android) and runs inside a per-user context (`AsyncLocalStorage`), so each user sees only their own agents, files, inbox and screens.
- **Clients**: the Android app (Compose) and the web app (Preact). They only see *names, status and capabilities*; hosts, URLs and keys are write-only on the hub (privacy contract, tested).
- **Connector (`connector/`)**: a tiny script on an agent machine that dials the hub over WebSocket with a per-agent token. The hub opens loopback forwarders and tunnels HTTP and WebSocket traffic through that single outbound link, so agents need no open ports or public name.
- **Design tokens (`design/tokens.json`)**: colours, radii, type and motion; a script generates the web CSS variables and the Android `Tokens.kt`.

## Agent kinds (plugins)

Each kind is declared in `server/config.js` (`KIND_SPECS`): fields, auth methods, warnings, conditional fields, and a runtime. Clients render add/edit forms from `GET /api/agent-kinds`, so a new kind needs no client change.

| Kind | How the hub reaches it |
| --- | --- |
| `hermes` | Connector (default) or direct host/port (advanced): chat, sessions, files, skills, screen |
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
