# Hosting overview

A Foxfleet hub is one Node process (Node 22 or newer, no `npm install` for the server) plus the built web app. Pick whichever of these fits:

| You have | Use |
| --- | --- |
| A Linux box you control | [systemd user service](./systemd) with the included deploy script |
| Docker | [Docker Compose](./docker) |
| No public IP / CGNAT / home network | [Cloudflare Tunnel](./cloudflare-tunnel) |
| A VPS with a domain | [Caddy or nginx](./reverse-proxy) in front |

Whatever you choose, the rules are the same:

1. **Bind to loopback** (the default) and let a proxy or tunnel provide **https**. The apps refuse plain http for public hosts.
2. Set `FOXFLEET_TRUSTED_ORIGINS` to the public origin(s). **This is required behind a proxy or tunnel**: the hub answers `403 Untrusted host` for any Host header it was not told about.
3. **Back up the data directory** ([backups](./backups)); it holds accounts and all saved keys.
4. Let WebSockets and Server-Sent Events through (chat streams as SSE; connectors and screen takeover use WebSockets).

Reference: [environment variables](./environment), [data directory](./data), [sizing](./sizing).

::: warning Status
The systemd and deploy-script path is the one the maintainers use. The Docker and Compose files are written but the image build has **not been verified end to end**; Caddy and nginx snippets are standard configuration that has not been run against this hub.
:::
