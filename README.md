<p align="center"><img src="design/brand/wordmark-light.png" alt="Foxfleet" width="360"></p>

**Foxfleet** is one calm place for all your AI agents: a small self-hosted **hub**, a **web app** and an **Android app**. Add the agents you already run (Hermes machines, MCP agents) and the API-key chat providers you use (OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok), then talk to them from your phone or browser. Free and MIT licensed.

> **Status: 0.1.0-alpha.** The hub and Android app are usable; the web app is being rebuilt to match the Android app (sign-in and first-run screens are done, agents/chat/admin are next). See [docs/roadmap.html](docs/roadmap.html).

## How it fits together

```
 phone / browser  ──https──▶  hub (Node, zero dependencies)  ◀──outbound WebSocket──  agent machines (connector)
   Android app                 accounts, per-user agents,                              Hermes, MCP agents
   web app                     keys stay on the hub                      API-key providers: hub calls them directly
```

- Clients only ever see agent *names, status and capabilities*; hosts, URLs and keys never leave the hub.
- Real accounts: first-run owner setup, optional invites or open registration, devices with revoke, rate limiting and lockout.
- Agents on your machines **dial out** to the hub with a per-agent token: no open ports, no public hostname per agent.
- Screen takeover (watch an agent's desktop, take control, hand back), files, images, voice, Markdown replies, slash commands.

## Quick start

**Docker**

```bash
git clone <this repo> foxfleet && cd foxfleet
docker compose up -d --build
docker compose logs foxfleet | grep "setup code"     # one-time code to create the owner
# open http://localhost:3080, create the owner, then Admin > Pair a phone
```

**Node 22+ (systemd)**: see [docs/INSTALL.md](docs/INSTALL.md) and [deploy/](deploy/).

**Android**: build with `cd android && ./gradlew assembleDebug` (JDK 17, Android SDK 36), install the APK, enter your hub address or scan the QR from Admin > Pair a phone.

**Connect an agent**: [docs/CONNECT-AGENT.md](docs/CONNECT-AGENT.md) (written so an AI agent can follow it).

## Repository layout

| Path | What |
| --- | --- |
| `server/` | The hub: HTTP API, accounts, plugins (agent kinds), connector tunnel, screen relay, MCP inbox. Node standard library only. Tests: `npm test` |
| `web/` | Web app: Preact + Vite + TypeScript. `cd web && npm ci && npm run build` (the hub serves `web/dist`) |
| `android/` | Android app (Kotlin, Jetpack Compose), package `dev.foxfleet.app` |
| `connector/` | `foxfleet-connector.mjs`, runs on a Hermes machine and dials the hub |
| `design/` | `tokens.json` (colours, radii, type) that generates the web CSS and the Android theme; brand assets |
| `deploy/` | systemd unit, deploy script (backup, tests, restart, health, rollback), Cloudflare Tunnel guide |
| `docs/` | Install, architecture, connecting agents, roadmap |

## Development

```bash
npm test                      # hub tests (node --test)
cd web && npm ci && npm test  # web unit tests (vitest) ; npm run dev proxies to a hub on :3080
cd android && ./gradlew testDebugUnitTest assembleDebug
node design/tools/gen-tokens.mjs   # after editing design/tokens.json
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Support

Foxfleet is free, and it will stay free. If it saves you time, you can chip in (these are placeholders until the maintainer sets up real accounts):

- GitHub Sponsors: _coming soon_ (`https://github.com/sponsors/REPLACE_WITH_GITHUB_USERNAME`)
- Ko-fi: _coming soon_ (`https://ko-fi.com/REPLACE_WITH_KOFI_NAME`)
- Other: `https://example.com/support-foxfleet`

Starring the repo, reporting bugs and sending pull requests help just as much.

## About the artwork

The wooden fox mascot and wordmark are **AI-generated** images (see [design/brand/README.md](design/brand/README.md)) and are included under the MIT licence.

## Licence

[MIT](LICENSE). Third-party components: [NOTICE.md](NOTICE.md).
