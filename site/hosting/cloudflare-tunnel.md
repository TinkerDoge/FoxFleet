# Behind a Cloudflare Tunnel

A tunnel gives your hub an https address without opening any port or needing a public IP. This is the setup the project's author uses. The hub keeps listening on loopback.

## Steps

1. Install `cloudflared` and log in: `cloudflared tunnel login`.
2. Create a tunnel and a DNS name on a domain you own:
   ```bash
   cloudflared tunnel create foxfleet
   cloudflared tunnel route dns foxfleet hub.example.com
   ```
3. `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <TUNNEL-ID>
   credentials-file: /home/you/.cloudflared/<TUNNEL-ID>.json
   ingress:
     - hostname: hub.example.com
       service: http://127.0.0.1:3080
     - service: http_status:404
   ```
4. Tell the hub its public origin: `FOXFLEET_TRUSTED_ORIGINS=https://hub.example.com` (env file or compose).
5. Run it: `cloudflared tunnel run foxfleet`, or `cloudflared service install` to keep it running.
6. Type `https://hub.example.com` in the app (or scan the pairing QR).

## What works through a tunnel

| Feature | Notes |
| --- | --- |
| **WebSockets** (connectors, screen takeover) | Work without extra settings. The hub pings every 25 s, below Cloudflare's idle limit. |
| **SSE** (chat streaming) | Works. Replies stream as `text/event-stream`. |
| **Uploads** | Cloudflare caps request bodies at 100 MB on most plans; Foxfleet caps files at **90 MiB** (chat JSON 10 MiB, other JSON 4 MiB), so the limits line up. |
| **Cookies** | The hub marks the session cookie `Secure` when the request is https: either `X-Forwarded-Proto: https` (sent by cloudflared) or the Host matches a trusted origin. |
| **Host and Origin checks** | **Required:** `FOXFLEET_TRUSTED_ORIGINS` must contain the public origin, otherwise the hub answers `403 Untrusted host`. Use the same hostname in the app and in this setting. |
| **CSP** | The hub sends a strict CSP itself; no Cloudflare rule is needed. Do not enable features that inject scripts (e.g. Rocket Loader, Auto Minify, Email Obfuscation) for this hostname. |

## Things to know

- **Client IPs.** The hub reads the socket address, which is the tunnel, so **all clients share one IP rate-limit bucket**. The per-username lockout still protects accounts. There is no trusted-proxy header setting yet (roadmap).
- **Never publish http.** The apps refuse plain http for public hosts.
- If you also use *Cloudflare Access* in front, the Android app and connectors cannot complete its browser login; bypass Access for the connector path or do not use it for the hub.

::: warning Status
The ingress layout above is what the maintainer runs for their own hub; it is not exercised by the automated tests.
:::
