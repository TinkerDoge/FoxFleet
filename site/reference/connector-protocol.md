# Connector protocol

Version `foxfleet.v1`. Source: `server/connector.js` (hub side), `connector/foxfleet-connector.mjs` (agent side). All frames are **JSON text messages** over one WebSocket.

## Connecting

```text
GET /connector                       (WebSocket upgrade, to the hub address)
Sec-WebSocket-Protocol: foxfleet.v1, <connector token>
```

The hub hashes the token (SHA-256), finds the agent, and accepts with sub-protocol `foxfleet.v1`. A wrong or rotated token is refused with `401`. A new connection for the same agent **replaces** the old one. The hub then sends `{"t":"hello","v":1}`.

## Frames

IDs (`id`) are random hex chosen by the hub per stream. `b` is base64.

| Direction | Frame | Fields | Meaning |
| --- | --- | --- | --- |
| hub → agent | `req` | `id, svc, method, url, headers` | Start an HTTP request. `svc` is `dashboard` or `api` (maps to `DASHBOARD_URL` / `API_URL`). |
| hub → agent | `body` | `id, b` | Request body chunk (≤ 48 KiB). |
| hub → agent | `body-end` | `id` | Request body finished. |
| hub → agent | `cancel` | `id` | Abort the stream (client went away). |
| agent → hub | `res` | `id, status, headers` | Response head. |
| agent → hub | `data` | `id, b` | Response body chunk. |
| agent → hub | `end` | `id` | Response finished. |
| hub → agent | `ws-open` | `id, svc, url, headers` | Open a WebSocket upgrade to the local service (agent rewrites `host`/`origin`). |
| agent → hub | `ws-up` | `id, headers{sec-websocket-accept, sec-websocket-protocol}` | Upgrade accepted; hub writes the `101` to its client. |
| both | `ws-data` | `id, b` | Raw WebSocket bytes after the handshake. |
| both | `ws-close` | `id` | Close the tunnelled socket. |
| agent → hub | `error` | `id` | Local failure; hub answers `502` (or closes). |
| hub → agent | `ping` | | Every 25 s. |
| agent → hub | `pong` | | Reply. The hub drops a link silent for 90 s. |

## Limits and behaviour

- At most **64** concurrent streams per connector (`503` beyond that).
- Hop-by-hop headers (`host`, `connection`, `upgrade`, `transfer-encoding`, …) are stripped; the response `content-length` is dropped (the hub re-frames).
- The hub exposes each connected agent through **two loopback-only HTTP servers on random ports**; the normal Hermes client talks to those, so nothing else in the hub knows about tunnelling.
- The connector reconnects with exponential backoff: 1 s doubling to 60 s, reset on a successful connect.
- Nothing is persisted: if the hub restarts, connectors simply reconnect.
