# Security policy

Foxfleet is alpha software that holds API keys and can drive agents on your machines. Please report vulnerabilities **privately**: open a GitHub security advisory on this repository (Security > Report a vulnerability) or email the maintainer address listed on the repository profile. Do not file public issues for security problems. We aim to acknowledge reports within a few days.

Design notes you may want to review: scrypt-hashed passwords; rotating session tokens with a device list; per-username lockout and per-IP throttle; CSRF/Origin checks on cookie sessions; per-agent connector tokens stored hashed; write-only secrets (never returned by the API); strict CSP on the web app (`img-src 'self' data: blob:`; remote Markdown images go through an SSRF-checked hub proxy, see docs/ARCHITECTURE.md); https required for public hubs in the apps.

Known limitations: rate limits key on the socket address (behind a proxy all clients share one bucket); TOTP is not implemented yet; Android builds are debug-signed.
