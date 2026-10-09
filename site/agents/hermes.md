# Hermes

Hermes is the agent kind with the most features: chat, images, files, skills, sessions, voice and the desktop screen. A Hermes install exposes a **dashboard** (default `127.0.0.1:9119`) and a **chat API** (default `127.0.0.1:8642`); Foxfleet talks to those two.

## Connector mode (default, recommended)

1. **Add → Hermes**, *Connection: Connector*. Pick an ID and display name. The *Profile* defaults to `default`.
2. Optionally enter the **Dashboard password** and **Chat API key** if your Hermes uses them. They are stored on the hub, never shown again, and used only for the hub's own calls.
3. Save. You see the **token and bootstrap prompt once**. The prompt the hub generates reads:

   > Connect this machine's Hermes agent to my Foxfleet (outbound only, no ports to open).
   > 1. `curl -fsSL https://hub.example.com/connector.mjs -o foxfleet-connector.mjs`
   > 2. `HUB_URL=https://hub.example.com FOXFLEET_TOKEN=<token> node foxfleet-connector.mjs` (Node 22+; keep it running with systemd)

   Give it to the agent, or run it yourself on the Hermes machine.
4. Keep it alive with systemd:
   ```ini
   [Service]
   Environment=HUB_URL=https://hub.example.com
   Environment=FOXFLEET_TOKEN=<token>
   ExecStart=/usr/bin/node /opt/foxfleet/foxfleet-connector.mjs
   Restart=always
   ```
5. The agent shows **Ready**; **Test** reports *Connector online* with dashboard and chat checks.

*New token* on an existing agent shows a fresh one and immediately disconnects the old. The connector forwards only to the two local addresses (`DASHBOARD_URL`, `API_URL`).

## Direct mode (advanced)

Choose *Connection: Direct* only when the hub can reach the Hermes machine itself (same LAN, VPN). Enter the fields marked advanced:

| Field | Default | Notes |
| --- | --- | --- |
| Host or IP | | write-only; never shown again |
| Dashboard port / Chat API port | 9119 / 8642 | write-only |
| Dashboard user / password | `admin` / | password write-only |
| Chat API key | | write-only |
| Dashboard / Chat API HTTPS origin | | optional; for a Hermes behind an https reverse proxy; origin only, no path |
| Dashboard session token | | only for dashboards running without auth |
| Upload folder on the agent | | absolute or `~/…`, no `..` |

The mode cannot be changed later; delete and re-add to switch.

## What you get

Chat with streaming and reasoning; sessions (list, search, resume); images; file upload (up to 90 MiB, streamed to the agent); skills (`#skill` or `/skill`); commands (`/new`, `/stop`, `/btw`, `/bg`, `/usage`, `/reasoning`, `/title`, `/rollback`, `/help`); voice transcription through the agent; artifacts and the desktop [screen](./screen-setup). The hub also has routes for cron jobs, logs and usage statistics of a Hermes agent (not yet in the OpenAPI spec).
