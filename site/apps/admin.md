# Admin (owner only)

Web: sidebar → **Admin**. Android: **Settings → Admin: pairing, invites, people**. Non-owners do not see it, and the server rejects the calls (`403 Owner only`).

## Pair a phone

A QR code (also at `/pair` on your hub while signed in as owner) for `foxfleet://connect?hub=<your hub>` (it only encodes the address you are currently using, never a secret). In the Android app, first screen → **Scan QR**. Links longer than the QR encoder's capacity (about 105 bytes) show as a link only.

## Who can join

`Closed` · `Invite only` · `Open` ([meaning](/concepts/accounts)).

## Invites

**New invite** creates a one-time link (`foxfleet://connect?hub=…&invite=…`) shown **once** with **Copy link** and a QR code. It expires (default 72 h). **Revoke** kills an open invite. New people open the link on their phone, or paste the hub address and invite on the web *Join* screen.

## People

Lists accounts with their role. **Disable** blocks sign-in and ends the person's sessions; **Enable** restores access. The owner cannot be disabled or removed. A disabled user's data stays on disk.
