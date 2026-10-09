# Connect an agent to your Foxfleet

For people **and for agents reading this**: how to connect a computer that runs Hermes (all of its profiles at once), or any API-key provider, to a Foxfleet hub.

## API-key providers (no machine needed)

OpenAI-compatible, OpenRouter, Z.ai, OpenCode and Grok: **Manage › Add agent**, pick the type, paste the key, **Test**, **Save**. The key stays on the hub and is never shown again.

## A computer running Hermes (one command, any number of profiles)

Requirements: Node.js **22+** on that computer, and Hermes installed for the same user (`~/.hermes`, or `%LOCALAPPDATA%\hermes` on Windows).

1. In the app: **Manage › Machines › Connect a machine**. The hub creates a pairing code (`K7QMX-2PD4H`, valid 15 minutes, single use) and shows the commands below.
2. On the computer, run **one** of:

   ```sh
   curl -fsSL https://YOUR-HUB/c/<code> | sh                       # macOS, Linux, WSL
   ```
   ```powershell
   irm https://YOUR-HUB/c/<code>.ps1 | iex                         # Windows PowerShell
   ```
   ```sh
   curl -fsSL https://YOUR-HUB/connector.mjs -o foxfleet-connector.mjs
   node foxfleet-connector.mjs pair --hub https://YOUR-HUB --code <code>   # Node only
   ```

3. The connector pairs, finds the Hermes profiles, and asks which to share (`--all`, or `--profiles default,coder`, skip the question). It then offers to keep itself running in the background (`--install-service`).
4. The app shows **Found N profiles: …**; each is now an agent named after its profile.

### If you are an agent asked to do this

Run exactly: `curl -fsSL https://YOUR-HUB/c/<code> | sh` (the code is in the prompt the owner copied). Answer **Enter** to share every profile found, or **n** and type numbers to choose. If there is no terminal, add `--all` by running the Node-only variant. Do not ask for, print or send Hermes passwords or API keys: the connector reads them locally. Report the last lines of its output. If it says the code is wrong or expired, ask the owner for a new one.

### Commands

`pair`, `run`, `profiles`, `status`, `install-service`, `uninstall-service`, `unpair`; flags `--name`, `--all`, `--profiles a,b`, `--install-service`, `--no-run`, `--hermes-home DIR`, `--dashboard-port N`. Config and token: `~/.config/foxfleet/connector.json` (mode `0600`).

### What leaves the computer

Only: the machine name you chose, the OS family, the names of the shared profiles, and, while someone uses an agent, that agent's chats, files and screen frames. Dashboard passwords, API keys and paths stay local; the connector signs in to Hermes on `127.0.0.1` itself.

### Manage and revoke

**Manage › Machines**: rename, **Re-pair** (kills the old token now, gives a new code, keeps the agents), **Revoke** (removes the machine and its agents). On the machine: `node foxfleet-connector.mjs unpair`.

### Troubleshooting

See the table in the docs: *Connect a real machine › Troubleshooting*. Most issues: Node older than 22, a code that expired (15 minutes) or was already used, the machine cannot reach the hub's https address, or Hermes itself is not running.

## Mailbox agents (Muse and other MCP agents)

Unchanged: **Add agent › MCP inbox**, copy the token shown once into the outside agent's MCP connector (`/mcp`, Bearer).

## Other local agents

The same machine connector is the intended carrier (see the docs, *Write your own plugin › Local agents through a machine*). Only Hermes profiles are discovered today.

## Busy-input controls (0.3.0-alpha)

An agent tells Foxfleet which send modes it supports (`capabilities.busy` on `GET /api/agents`): `queue`, `steer`, `interrupt`.

- **Hermes** with run controls (`GET /v1/capabilities` lists `run_submission`, `run_events_sse`, `run_steer`, `run_stop`): `queue`, `steer`, `interrupt`. The hub then uses `POST /v1/runs` (with an `Idempotency-Key`), `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/steer` and `/stop`. The profile's API key is the same one chat already uses; no new setting is needed.
- **Older Hermes** (no run controls): `queue` and `interrupt` (the hub closes the stream, waits for it to end and sends the replacement through `/v1/chat/completions`).
- **OpenAI-compatible and Grok**: `queue`, and `interrupt` by aborting the stream and resubmitting with the stored history. The provider is not told to stop computing; closing the stream is all the hub can do.
- **MCP inbox**: `queue` only (messages are delivered when the agent next checks in).

`POST /api/agents/{name}/messages` takes `{ messages, session_id?, mode, client_id }`, stores the message and answers `202 { message, run_id? }` (or `200` for a repeated `client_id`). Follow a started reply with `GET …/runs/{id}/events`. `GET …/queue?session_id=` returns what is waiting. See `contract/openapi.json`.
