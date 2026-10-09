# Security overview and threat model

Foxfleet holds API keys and can drive agents (and desktops) on your machines. It is **alpha software**; read the [known limitations](#known-limitations) before exposing it.

## What we protect

| Asset | How |
| --- | --- |
| Account passwords | scrypt hashes (N=2¹⁵, r=8, p=1), never logged or returned |
| Session tokens | random, stored only as SHA-256, rotating, revocable per device |
| Agent secrets (API keys, dashboard passwords, hosts, URLs) | write-only on the hub: no API ever returns them; `0600` files |
| Connector and MCP tokens | per agent, stored hashed, shown once, rotatable |
| Other users' data | per-user context; no cross-user route exists |
| Your IP and browsing | remote Markdown images fetched by the hub; strict CSP |
| Your agent's desktop | single-use short tickets, lease, auto hand-back, `FLAG_SECURE` |

## Threat model

**In scope (we try to defend):**

- An unauthenticated attacker who can reach the hub: login gate on every route except `/health`, `/api/auth*` and static files; throttling and lockout; setup code on non-loopback first run; strict error messages.
- A malicious web page making a logged-in browser call the hub (CSRF): Host, Origin and `Sec-Fetch-Site` checks on every request, JSON-only mutations, `SameSite=Lax` cookie.
- Malicious agent output (XSS via Markdown/HTML, tracking pixels, SSRF through image URLs): sanitizer + CSP + [media proxy](./media-proxy).
- A curious or malicious **other user** on the same hub: isolation by per-user registries.
- Leaks in API responses or error messages: tested contract that no host/IP/URL/secret is present.

**Out of scope / not protected:**

- A compromised hub host or an attacker with read access to the data directory (secrets are stored in `config.json` unencrypted, mode 0600).
- A malicious **owner** (the owner administers the hub).
- Malicious or compromised *agents* acting within their own permissions: what a Hermes agent does on its machine is up to Hermes.
- Denial of service beyond the built-in limits.
- Network attackers if you serve plain http. Use https.

## Known limitations

- Rate limits key on the socket address; behind a proxy or tunnel all clients share one bucket (per-username lockout still works). No trusted-proxy setting yet.
- **TOTP two-factor is not implemented** (a slot exists).
- Android builds are debug-signed; no release keystore; no store listing.
- No audit log of admin actions.
- Secrets at rest are protected by file permissions, not encrypted.

Details: [Authentication](./auth) · [Secrets and privacy](./secrets) · [Media proxy](./media-proxy) · [Takeover safeguards](./takeover) · [Reporting](./reporting).
