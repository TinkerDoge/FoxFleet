# Takeover safeguards

Letting a person drive an agent's desktop is the most sensitive feature. The design:

| Safeguard | Detail |
| --- | --- |
| **No credentials on the client** | The viewer never sees the dashboard credential. It gets a **hub ticket**: single-use, 30 s, bound to one agent and one user, mapped on the hub to the upstream display ticket. |
| **View first** | You can only watch until you press **Take over**. |
| **Lease** | Control uses the agent's display **lease** (`display.lease.acquire`), so the agent knows a human holds the desktop. |
| **Visible** | A red border and a countdown are shown the whole time you hold control. |
| **Time-boxed** | Auto hand-back after **15 minutes** (`TAKEOVER_MAX_MS`). |
| **Hand-back on leave** | Leaving the screen, closing the tab (`pagehide` with a keepalive request) or losing the socket releases the lease. |
| **Per-user isolation** | Tickets, leases and relays live in the user's own registry. |
| **Android `FLAG_SECURE`** | The window cannot be captured or shown in recents while the screen is open. noVNC runs in a locked WebView. |
| **Connector mode** | The screen WebSocket rides the same outbound link; nothing new is exposed. |

Not provided: a recording or audit trail of what you did on the desktop.
