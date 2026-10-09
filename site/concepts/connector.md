# The connector

Most agents that run on a real machine sit behind a home router or firewall. Instead of making you open ports, Foxfleet inverts the connection: a tiny script on the agent's machine **dials out** to the hub.

```text
Hermes machine                              Hub
┌────────────────────┐   wss://hub/connector   ┌─────────────────────────┐
│ dashboard :9119    │◄──┐  one WebSocket       │ per-agent loopback      │
│ chat API  :8642    │   │  (outbound only)     │ forwarders (random      │
│ foxfleet-connector ├───┴─────────────────────►│ ports, 127.0.0.1 only)  │
└────────────────────┘                          └──────────┬──────────────┘
                                                           │ normal Hermes client
                                                    chat, sessions, files, screen
```

- **Auth.** Each agent has its own random token. The app shows it once; the hub stores only its SHA-256 hash. The connector sends it as a WebSocket sub-protocol (`foxfleet.v1`, `<token>`). *New token* on the agent rotates it and drops the old link.
- **Tunnelling.** The hub opens two loopback-only forwarders per connected agent (dashboard and chat API) and turns every request into frames over the single socket. WebSocket upgrades (screen takeover, the gateway socket) are tunnelled as raw frames after the handshake, so [takeover](/apps/screen) works in connector mode with tickets and hand-back unchanged.
- **Safety.** The connector forwards **only** to the two local addresses it was configured with. At most 64 concurrent streams per agent. The hub pings every 25 s and drops a silent link after 90 s; the connector reconnects with backoff from 1 s up to 60 s.
- **Transport.** Plain `ws://` is refused unless the hub is localhost or you set `ALLOW_INSECURE_HUB=1`.

Full frame list: [Connector protocol](/reference/connector-protocol). Setup steps: [Hermes](/agents/hermes).

## Connector vs direct

| | Connector (default) | Direct (advanced) |
| --- | --- | --- |
| Who dials | the agent machine, out to the hub | the hub, in to the agent's host and ports |
| Open ports on the agent side | none | dashboard and API ports reachable from the hub |
| Needs a name for the agent | no | yes (host or IP, kept on the hub) |
