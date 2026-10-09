# FAQ and troubleshooting

## Setup

**I get `403 Untrusted host` (or a blank page) behind a proxy or tunnel.**
Set `FOXFLEET_TRUSTED_ORIGINS=https://hub.example.com` (exactly the origin people type, no path) and restart. The hub does not trust forwarded headers to learn its own name.

**`403 Cross-origin request rejected` when signing in.**
The browser's `Origin` is not in `FOXFLEET_TRUSTED_ORIGINS`, or a script is calling from another site. Use the same hostname everywhere.

**There is no setup code in the log.**
Codes are printed only on non-loopback binds (`FOXFLEET_HOST=0.0.0.0`, Docker). On `127.0.0.1` the first screen creates the owner without a code. Set `FOXFLEET_SETUP_CODE` to choose one.

**I lost my owner password.**
There is no reset flow. Stop the hub, move `accounts/` aside (this deletes all accounts and sessions; agents in `config.json` stay) and start again to create a new owner, or start once with `FOXFLEET_PASSWORD` set while `accounts/` is empty.

**The login page says "Too many attempts".**
Lockouts: 5 failures per username per 15 min, 30 per IP per 10 min. Wait for the time shown. Behind a proxy everyone shares the IP bucket.

## Phones

**The app says the hub address is invalid.**
`https://` is required for public hosts. For a LAN hub with an http address, switch on *Allow http on this network* on the first screen.

**Scan QR does nothing.**
It uses Google's code scanner (Play services). Without Play services, type the address or open the `foxfleet://connect?hub=…` link on the phone.

**QR shows only a link.**
Very long hub addresses exceed the QR encoder's capacity (about 105 bytes); the link is still shown.

## Agents

**A Hermes connector agent stays offline.** See the [troubleshooting table](/agents/real-machine#troubleshooting). Check that the connector process is running, the token is current, and `curl https://hub/connector.mjs` works from that machine.

**`Test` says "Chat API unavailable or authentication failed" for a provider.** Wrong key, wrong base URL, or the provider has no `/models` route. The test only calls `GET {base}/models`.

**Z.ai refuses my key / I'm worried about the coding endpoint.** Read the [Z.ai page](/agents/zai).

**Images do not appear in a reply.** Remote images load through the hub's [media proxy](/security/media-proxy): it needs outbound https from the hub, blocks private addresses, SVG and files above 8 MB.

**Voice button missing on the web.** Your browser has no Web Speech API (e.g. Firefox); the button is hidden by design.

## Streaming and uploads

**Replies arrive all at once.** A proxy is buffering SSE. nginx: `proxy_buffering off`; Caddy: `flush_interval -1`.

**Uploads fail above some size.** A proxy body limit is below 90 MiB (nginx `client_max_body_size`, Cloudflare 100 MB plan limit).

## Other

**Is it production ready?** No: alpha. Read [security limitations](/security/#known-limitations) and the [roadmap](/project/roadmap).

**Does Foxfleet phone home?** No analytics or update checks. The hub only contacts providers you configured and, via the media proxy, image URLs in replies.

**How do I move to a new server?** [Back up](/hosting/backups) the data directory, restore on the new host, set `FOXFLEET_TRUSTED_ORIGINS`, and point your DNS or tunnel at it. Apps keep working if the hub address is unchanged.
