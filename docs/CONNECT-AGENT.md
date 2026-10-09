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

## Native sessions (preferred when the machine has Hermes installed)

The connector can run Hermes's own UI gateway (`python -m tui_gateway.entry`, the protocol Hermes's TUI and dashboard chat use) for each shared profile and relay a small allowlist of actions to the hub over the same outbound connection. Nothing listens on the machine, the profile's credentials stay in its own `HERMES_HOME`, and the hub cannot call arbitrary Hermes methods.

- **Finding Hermes.** Set `uiGatewayCommand` in the connector config (an array such as `["/home/me/.hermes/hermes-agent/venv/bin/python","-m","tui_gateway.entry"]`, with `uiGatewayCwd` for the checkout), or `FOXFLEET_HERMES_GATEWAY_CMD` as a JSON array. Without either, the connector looks for `<hermes root>/hermes-agent/venv` or `.venv`. `uiGateway: "off"` disables it. If nothing is found the profile keeps using HTTP (`/v1/runs`, then chat completions).
- **What changes for you.** Send modes map to Hermes itself: Queue is `prompt.submit` with `queued`, Steer is `session.steer`, Interrupt & send is `session.redirect`. The hub shows exactly what Hermes answered and never turns a rejected redirect into a Stop. Approval and clarification questions arrive as cards and can be answered once.
- **/busy** changes a Hermes setting for the whole profile, not for one chat, so Foxfleet only changes it when you ask.
- **Needs Python 3.14** for the pinned Hermes dependencies at the time of writing (see `design/notes/hermes-ui-gateway.md`).

### Setting up the native gateway (and checking it)

Native sessions need the machine to have the Hermes **checkout** (the connector starts its `tui_gateway`). Nothing else changes for you: chats still work over HTTP without it.

```
foxfleet connector doctor          # or: node foxfleet-connector.mjs doctor
```

It lists the Hermes profiles it found, how it found the gateway, starts the gateway to prove it works and prints a fix when something is off. Discovery order: `uiGatewayCommand` in `connector.json` (an array, e.g. `["/home/me/hermes-agent/venv/bin/python","-m","tui_gateway.entry"]`, optional `uiGatewayCwd`), the `FOXFLEET_HERMES_GATEWAY_CMD` environment variable (same array as JSON), `hermesAgentDir` / `HERMES_AGENT_DIR` (a checkout with a `venv`), a checkout next to the Hermes home (`hermes-agent`, `~/hermes-agent`, `~/.hermes/hermes-agent`), then the interpreter named in the first line of the `hermes` command on PATH. `"uiGateway": "off"` disables it. Hermes' own dependencies decide the Python version (3.14 at the time of writing): use the interpreter Hermes itself runs in.
