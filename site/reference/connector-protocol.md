# Connector protocol

Version `foxfleet.v1`, hello `v: 2` (one socket per **machine**, many agents). Source: `server/connector.js` (hub side), `connector/foxfleet-connector.mjs` (agent side). All frames are **JSON text messages** over one WebSocket.

## Connecting

```text
GET /connector                       (WebSocket upgrade, to the hub address)
Sec-WebSocket-Protocol: foxfleet.v1, <machine token>
```

The machine token (`<machineId>.<secret>`) is obtained once by `POST /api/machines/redeem` with a pairing code (see the API reference). The hub hashes the secret (SHA-256), finds the machine, and accepts with sub-protocol `foxfleet.v1`. A wrong, revoked or rotated token is refused with `401`. A new connection for the same machine **replaces** the old one. The hub then sends `{"t":"hello","v":2}`.

Right after connecting (and whenever the set changes) the connector sends which profiles it shares; the hub creates, keeps or removes the matching agents and answers with the agent names it assigned:

```json
{"t":"profiles","os":"linux","profiles":[{"profile":"default"},{"profile":"coder"}]}
{"t":"registered","agents":[{"profile":"default","agent":"default"},{"profile":"coder","agent":"coder"}]}
```

## Frames

IDs (`id`) are random hex chosen by the hub per stream. `b` is base64.

| Direction | Frame | Fields | Meaning |
| --- | --- | --- | --- |
| agent → hub | `profiles` | `os, profiles[{profile}]` | The profiles this machine shares now. |
| hub → agent | `registered` | `agents[{profile, agent}]` | The agents the hub created or kept for them. |
| hub → agent | `req` | `id, agent, svc, method, url, headers` | Start an HTTP request for one profile. `svc` is `dashboard` or `api`; the connector resolves it to that profile's local port and **adds that profile's credentials itself**. |
| hub → agent | `body` | `id, b` | Request body chunk (≤ 48 KiB). |
| hub → agent | `body-end` | `id` | Request body finished. |
| hub → agent | `cancel` | `id` | Abort the stream (client went away). |
| agent → hub | `res` | `id, status, headers` | Response head. |
| agent → hub | `data` | `id, b` | Response body chunk. |
| agent → hub | `end` | `id` | Response finished. |
| hub → agent | `ws-open` | `id, agent, svc, url, headers` | Open a WebSocket upgrade to the local service (agent rewrites `host`/`origin`). |
| agent → hub | `ws-up` | `id, headers{sec-websocket-accept, sec-websocket-protocol}` | Upgrade accepted; hub writes the `101` to its client. |
| both | `ws-data` | `id, b` | Raw WebSocket bytes after the handshake. |
| both | `ws-close` | `id` | Close the tunnelled socket. |
| agent → hub | `error` | `id` | Local failure; hub answers `502` (or closes). |
| hub → agent | `ping` | | Every 25 s. |
| agent → hub | `pong` | | Reply. The hub drops a link silent for 90 s. |

## Limits and behaviour

- At most **64** concurrent streams per connector (`503` beyond that).
- Hop-by-hop headers (`host`, `connection`, `upgrade`, `transfer-encoding`, …) are stripped; the response `content-length` is dropped (the hub re-frames).
- The hub exposes each shared profile through **two loopback-only HTTP servers on random ports**; the normal Hermes client talks to those, so nothing else in the hub knows about tunnelling.
- The connector reconnects with exponential backoff: 1 s doubling to 60 s, reset on a successful connect.
- Nothing is persisted: if the hub restarts, connectors simply reconnect.
