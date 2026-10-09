# Concepts

```text
phone / browser  ──►  HUB (one Node process)  ──►  agents
 Android app           accounts, secrets            Hermes machine ◄── connector (dials out)
 Web app (PWA)         per-user registries          API-key providers (the hub calls them)
                       media proxy, screen relay    MCP-inbox agents (they call the hub)
```

| Piece | What it is |
| --- | --- |
| **Hub** (`server/`) | One Node process with **no runtime dependencies**. Owns accounts, per-user agent registries, secrets, sessions, files and the screen relay. Serves the built web app, `/api/*`, the connector WebSocket (`/connector`), the MCP endpoint (`/mcp`) and the connector script (`/connector.mjs`). |
| **Web app** (`web/`) | Preact + TypeScript single-page app, served by the hub from `web/dist`. Installable as a PWA. |
| **Android app** (`android/`) | Kotlin/Jetpack Compose. Knows nothing about your hub until you give it an address; supports several hubs. |
| **Connector** (`connector/`) | A ~60-line Node script run on a Hermes machine. Dials out to the hub and tunnels HTTP and WebSocket traffic back. |
| **Contract** (`contract/`) | The OpenAPI 3.1 spec plus a scenario that tests the hub and the web mock against it. |

## The privacy contract

Clients never receive hosts, ports, URLs, profile paths or credentials. They see an agent as a **name, kind, online/ready status and capabilities**. Anything sensitive is *write-only*: you can set it, the hub uses it, nobody can read it back; the API returns booleans like `hasApiKey` instead. A test (`server/test/v05.test.js`) scans responses for leaks.

## Where to go next

- [Accounts and roles](./accounts)
- [Agents, kinds and capabilities](./agents)
- [The connector](./connector)
- [Sessions and devices](./sessions-devices)
