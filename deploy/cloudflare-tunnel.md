# Publishing a hub through a Cloudflare Tunnel

Foxfleet binds to loopback by default; a tunnel gives it an https address without opening any port.

1. Install `cloudflared` and log in: `cloudflared tunnel login`.
2. Create a tunnel and a DNS name you own: `cloudflared tunnel create foxfleet` then `cloudflared tunnel route dns foxfleet hub.example.com`.
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
5. Run it: `cloudflared tunnel run foxfleet` (or `cloudflared service install`).

Notes
- WebSockets (agent connectors, screen) work through the tunnel without extra settings. The hub pings every 25 s, under Cloudflare's idle limit.
- Uploads: Cloudflare caps request bodies at 100 MB on most plans; Foxfleet caps files at 90 MiB.
- Rate limits currently key on the socket address, which is the tunnel; the per-username lockout still protects accounts.
- Use the same hostname in the app (Hub address) and in `FOXFLEET_TRUSTED_ORIGINS`.
- Never put an http address on the public internet: the app refuses http for public hosts.
