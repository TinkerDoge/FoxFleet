# Screen takeover setup

Only agents with the `screen` capability (Hermes) have a screen. The hub does not run a desktop itself: it relays the agent's **virtual desktop** (Xfce on TigerVNC, managed by Hermes) through the Hermes dashboard's gateway (`display.status`, `display.start`, `display.observe`, `display.lease.*`).

## What must be true

1. The agent is **Ready** (connector online or direct reachable).
2. The Hermes install **supports** the display feature and has it installed. The hub asks `display.status`; a Hermes without it, or with a blocker, reports `supported: false` plus a `blocker` message that the app shows.
3. For connector agents nothing else is needed: the hub tunnels the screen WebSocket over the connector's own link.

## Flow

```text
open Screen → status → (start the desktop if not running) → observe: hub mints a single-use ticket (30 s)
  → viewer connects wss://hub/api/agents/<id>/screen/ws?ticket=… (view only)
  → Take over: hub acquires the agent's display lease; you control; a red border + countdown show
  → Hand back (or 15 min, or leaving the screen): the lease is released
```

Details and safeguards: [Using screen takeover](/apps/screen), [Takeover safeguards](/security/takeover).

::: warning Status
The relay is covered by unit tests with a fake upstream. Using it against a real Hermes display, on the web and on a physical Android device, has not been verified end to end by the maintainers since the rename.
:::
