# Connect a real-machine agent

"Real machine" means an agent that lives on a computer (a Hermes install, with a dashboard and chat API on localhost) rather than behind a cloud API. The recommended path is the [connector](/concepts/connector): the machine dials out, so you open no ports.

This page is written so a person **or an AI agent** can follow it. The full upstream copy is [`docs/CONNECT-AGENT.md`](https://github.com/TinkerDoge/FoxFleet/blob/main/docs/CONNECT-AGENT.md), which the hub also serves.

## Checklist

1. **Hub reachable over https from the agent machine.** `curl -fsSL https://hub.example.com/connector.mjs | head -3` prints JavaScript.
2. **Node 22 or newer** on the agent machine (`node --version`); the connector uses the global `WebSocket`.
3. **The agent's local services answer:** `curl -s http://127.0.0.1:9119/api/status` (dashboard) and the chat API on `127.0.0.1:8642`. Different ports? Set `DASHBOARD_URL` / `API_URL` for the connector.
4. In the app add a **Hermes** agent with *Connection: Connector*. Save; the app shows a one-time **token** and a ready-made **bootstrap prompt**.
5. On the agent machine run what the prompt says:
   ```bash
   curl -fsSL https://hub.example.com/connector.mjs -o foxfleet-connector.mjs
   HUB_URL=https://hub.example.com FOXFLEET_TOKEN=<token> node foxfleet-connector.mjs
   ```
6. The connector prints `connected to hub`; the agent turns **Ready** in seconds. Use **Test**.
7. Keep it running with systemd (`Restart=always`) or a process manager. It reconnects by itself (1 s → 60 s backoff).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `401` when connecting | Token wrong or rotated. Use *New token* in the app. |
| `Refusing plain ws:// to a non-local hub` | Hub address is http. Use https, or `ALLOW_INSECURE_HUB=1` on a trusted LAN. |
| `Node 22 or newer is required` | Old Node: no global `WebSocket`. |
| Online but chat fails | Dashboard password or chat API key missing: add them in the agent form (write-only, stored on the hub). |

Then enable the desktop if you want it: [Screen takeover setup](./screen-setup).
