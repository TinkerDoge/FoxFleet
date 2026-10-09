# Connect an agent to your Foxfleet

This page is written so a person **or an AI agent** can follow it end to end. The hub never needs to
reach into your network: the agent machine dials **out** to the hub, so you open no ports and need no
public hostname or DNS for the agent.

## Which path?

| Agent | Path | What runs where |
| --- | --- | --- |
| **Hermes** (default) | Connector (outbound WebSocket) | `foxfleet-connector.mjs` on the Hermes machine |
| Hermes, advanced | Direct | The hub dials the Hermes host and ports itself (set in the app under *Advanced*) |
| **Scribe** and other MCP agents | Inbox (MCP over HTTPS) | The agent calls the hub's `/mcp` with a bearer token. Also outbound only |
| OpenAI, OpenRouter, Z.ai, OpenCode, Grok | API key | Nothing on your machines. Paste a key in the app |

## Hermes: connector (recommended)

1. In the app: **Settings → Manage agents → Add → Hermes** (connection: *Connector*). Name it and save.
2. The app shows a **one-time token** and a ready-made **bootstrap prompt**. Copy the prompt.
   The token is a secret; if it leaks, tap *New token* on the agent and the old one stops working at once.
3. Give the prompt to the agent (or run it yourself) on the machine that runs Hermes. It is just:

```bash
# Node 22 or newer. Use your own hub address.
curl -fsSL https://YOUR-HUB/connector.mjs -o foxfleet-connector.mjs
HUB_URL=https://YOUR-HUB FOXFLEET_TOKEN=<token from the app> node foxfleet-connector.mjs
```

4. Keep it running. With systemd:

```ini
[Service]
Environment=HUB_URL=https://YOUR-HUB
Environment=FOXFLEET_TOKEN=<token>
ExecStart=/usr/bin/node /opt/foxfleet/foxfleet-connector.mjs
Restart=always
```

5. In the app the agent turns **Ready** within seconds. Use **Test** to see *Connector online*, dashboard and chat.

Defaults: dashboard `http://127.0.0.1:9119`, chat API `http://127.0.0.1:8642`. Override with
`DASHBOARD_URL` / `API_URL`. The connector forwards only to those two addresses.

Dashboard password and API key (if your Hermes uses them) are entered once in the app. They are stored on the
hub, never shown again, and used for the hub's own calls into your Hermes.

### What the agent can follow by itself (checklist)
- [ ] `node --version` is 22 or newer
- [ ] `curl -fsSL <hub>/connector.mjs` returns JavaScript (the hub address is reachable over https)
- [ ] Hermes dashboard and API answer on localhost (`curl -s http://127.0.0.1:9119/api/status`)
- [ ] Connector prints `connected to hub`, and reconnects by itself (backoff 1s → 60s) after a drop
- [ ] 401 on connect means a wrong or rotated token; get a new one in the app

### Security notes
- Plain `ws://` is refused unless the hub is localhost or you set `ALLOW_INSECURE_HUB=1` (trusted LAN only).
- One token per agent, stored on the hub only as a SHA-256 hash.
- Screen takeover works over a connector too: the hub tunnels the screen WebSocket through the same outbound link (tickets, lease and hand-back unchanged).

## Scribe and MCP agents (inbox)
Add the agent with type **MCP inbox**. The app shows a token once. Point the agent's MCP client at
`https://YOUR-HUB/mcp` with header `Authorization: Bearer <token>`. Replies land in the conversation.

## API-key chat agents
Add OpenRouter, Z.ai, OpenCode or Grok in the app and paste your key. Z.ai: use the *general* endpoint
unless you have a Coding Plan key; Z.ai restricts the Coding Plan endpoint to officially supported coding tools.

## Pairing the phone
Open the app, enter your hub address (or scan the QR / open a link like `foxfleet://connect?hub=https://YOUR-HUB`).
Use `http://` only for a LAN or dev hub, and only after switching on *Allow http on this network*.
