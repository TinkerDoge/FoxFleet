# Authentication

## Passwords and accounts

- scrypt (N=32768, r=8, p=1, 32-byte key, 16-byte random salt); minimum length 10, maximum 256.
- First owner via the one-time **setup code** on non-loopback binds (compared in constant time).
- Registration `closed` by default; invites are random 12-byte codes, stored hashed, expiring, revocable; at most 200 open.

## Sessions

- 30-day sessions bound to a **device row**. The token is random and stored as SHA-256 only.
- **Rotation:** a token older than 24 h is replaced on use; the previous token still works for 60 s (so parallel requests don't fail).
- Web: cookie `foxfleet_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` over https. Android: bearer token (`client=app`).
- Revoke one device, sign out everywhere, or change password (revokes all other devices). Disabling a user deletes their sessions.

## Rate limiting and lockout

| Key | Limit | Lock |
| --- | --- | --- |
| Per source IP, failed sign-ins | 30 per 10 min | 10 min |
| Per username, failed sign-ins | 5 per 15 min | 15 min |
| Per user, wrong current password on change | 5 per 15 min | 15 min |
| Per IP, all `/api/auth*` requests | 60 per minute | `429` until the minute ends |

Locked requests get `429` with a retry time. Behind a proxy the "IP" is the proxy ([limitation](./index#known-limitations)).

## Host, CSRF and Origin checks

Applied to **every** request, whatever the credential:

- The `Host` header must be the hub's own listening address (loopback names on a loopback bind) or the host of an origin listed in `FOXFLEET_TRUSTED_ORIGINS`. Otherwise: `403 Untrusted host`. **Behind a proxy or tunnel you must set `FOXFLEET_TRUSTED_ORIGINS`**; forwarded headers are never trusted to widen this.
- Non-`GET` requests: `Sec-Fetch-Site: cross-site` and any `Origin` that is not one of the trusted origins are rejected (`403 Cross-origin request rejected`).
- Mutations must be `application/json` (file uploads: `application/octet-stream` to the files route), else `415`.

Together with the `SameSite=Lax` cookie this blocks cross-site request forgery.

## Transport

Apps require **https** except for explicitly allowed LAN/dev hubs. Connectors refuse plain `ws://` to non-local hubs unless `ALLOW_INSECURE_HUB=1`.

## Two-factor

Not yet. Users have a `totp` slot and login accepts an optional `code`, but there is no enrolment flow.

## Single-user mode

An internal option for local development that disables login; the hub refuses it unless bound to loopback.
