# Sessions and devices

The word *session* means two different things in Foxfleet.

## Chat sessions (conversations)

For agents with the `sessions` capability (Hermes) the hub lists, searches and reads past conversations from the agent (`GET /api/agents/{name}/sessions`, `…/sessions/{id}/messages`). Older images in a long chat are collapsed to an `[image]` marker so bytes are not uploaded repeatedly.

## Sign-in sessions and devices

Every sign-in creates a **device** row (`GET /api/devices`): a name, kind (`web` or `app`), creation time and a flag for the current one.

- Tokens are random; the hub stores only a SHA-256 hash.
- A session lasts 30 days. Tokens **rotate** once a day (`ROTATE_AFTER`): the old token still works for 60 seconds so an in-flight request does not fail.
- You can **revoke** a single device, **sign out everywhere**, or change your password (which requires the current one).
- Owners see the same list for themselves only; there is no admin view of other people's devices.

In the apps: web *Devices and security*, Android *Settings → Devices & security*.
