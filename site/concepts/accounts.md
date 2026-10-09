# Accounts and roles

Foxfleet is multi-user from the first line of code, so a single hub can be shared with family or a team without sharing keys.

## Roles

| Role | Can do |
| --- | --- |
| **owner** (the first account) | Everything a user can, plus the **Admin** area: registration mode, invites, pairing QR, listing and disabling people. Cannot be disabled or removed. |
| **user** | Their own agents, chats, files, devices and password. |

Every request runs inside a per-user context (`AsyncLocalStorage`). One user's agents, saved secrets, inbox, uploaded files, upstream caches and screen tickets are invisible to everyone else, including other clients of the same hub. The owner's data sits in the data directory itself; other users' data sits in `users/<id>/`. See [Data directory](/hosting/data).

## Registration modes

Set by the owner in *Admin → Who can join* (`GET/PUT /api/admin/registration`):

| Mode | Meaning |
| --- | --- |
| `closed` (default) | Nobody can register, and invite links are not accepted. |
| `invite` | A person needs a one-time **invite link**. Invites last 72 hours by default (`ttlHours`, 1 hour to 30 days), at most 200 open invites. The link is a `foxfleet://connect` deep link that carries the hub address and the invite. |
| `open` | Anyone who can reach the hub can create an account. Use only on a private network. |

The hub supports up to 1000 users.

## Signing in

- **Web:** username + password; the hub sets an `HttpOnly`, `SameSite=Lax` cookie `foxfleet_session` (plus `Secure` when the request came over https).
- **Android:** same login with `client: "app"`; the hub returns a **bearer token** that the app stores and sends as `Authorization: Bearer …`.
- Passwords are scrypt hashes. After repeated failures the account or source address is locked out for a while ([details](/security/auth)).
- An account can be **disabled** by the owner; its sessions stop working.
- A `totp` slot exists on users and login accepts an optional `code`, but **two-factor enrolment is not implemented yet** (roadmap).
