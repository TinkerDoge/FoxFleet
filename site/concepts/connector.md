# The connector

The connector is a small Node 22 script (`foxfleet-connector.mjs`, no dependencies) that runs on **one computer** and lets the hub reach the Hermes profiles on it without any open port, DNS name or tunnel.

```
 your computer                                      your hub
┌─────────────────────────────┐                ┌─────────────────────────────┐
│ Hermes dashboard :9119      │◄──┐            │ per-profile loopback        │
│ Hermes chat API  :8642      │◄─┐│  ONE       │ forwarders (127.0.0.1 only) │
│ profiles: default coder research│  ││ outbound   │ coder  ─┐                   │
│                             │  ││ WebSocket  │ research   ─┼─ normal Hermes    │
│ foxfleet-connector ─────────┼──┴┴───────────►│ default─┘   client          │
└─────────────────────────────┘                └─────────────────────────────┘
```

- **One process per machine**, not per profile. Every frame on the socket names its agent, so profiles are multiplexed and routed independently.
- **Pairing**: you create a 15-minute single-use code in the app; the connector trades it once for a **machine token**, saved as a `0600` file in its config folder (`~/.config/foxfleet/connector.json`, `~/Library/Application Support/foxfleet/…`, `%APPDATA%\foxfleet\…`). The hub keeps only a SHA-256 hash.
- **Discovery**: it reads the Hermes layout locally, lets you choose profiles, and tells the hub only their names. The hub creates one agent per profile (deduping names).
- **Credentials stay local**: the connector signs in to each profile's dashboard and adds its API key to requests itself.
- **Revoke / rotate** from **Manage › Machines**: the token dies at once and the agents go away (revoke) or stay offline until re-paired (rotate).
- It only ever talks to `127.0.0.1` ports, and refuses a plain `http://` hub unless that is a loopback address.

| | Machine connector (default) | Direct (advanced) |
| --- | --- | --- |
| Who dials | the machine dials the hub | the hub dials the agent |
| Open ports / DNS on the agent | none | yes |
| Credentials | stay on the machine | stored on the hub |
| Setup | one command per computer | host, ports and credentials per agent |

Protocol details: [Connector protocol](/reference/connector-protocol). Step by step: [Connect a real machine](/agents/real-machine).
