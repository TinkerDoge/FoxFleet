# Screen takeover

Watch an agent's virtual desktop and, when you choose, drive it. Available for agents with the `screen` capability (Hermes), when the agent reports the display feature is supported ([setup](/agents/screen-setup)).

## Using it

1. Open the agent and tap **Screen**. If the desktop is not running the hub starts it.
2. You are **view only**: you watch, you cannot click or type.
3. **Take over** gives you control. A **red border** and a **countdown to automatic hand-back** appear (15 minutes maximum).
4. **Touch controls** (web on a phone, and the Android app): tap = click, long-press = right-click, drag = move or drag, two-finger drag = scroll, pinch = zoom (a second tap on **Fit / 100%** resets it). The **keys row** has Esc, Tab, Enter, arrows, a keyboard button, and **sticky Ctrl, Alt and Shift**: tap one, then the next key or click carries it (tap again to release).
5. **Hand back** returns control to the agent. It also happens automatically at the deadline, when you leave the screen, and when you close the tab.

## Platform notes

- **Web:** noVNC is lazy-loaded (a separate chunk, only fetched here).
- **Android:** noVNC runs in a locked-down WebView; the window is **`FLAG_SECURE`** while the screen is open, so it cannot be screenshotted or appear in the recents thumbnail.

## Troubleshooting

The viewer never stays blank: it says what is wrong.

| Message | What it means | What to do |
| --- | --- | --- |
| **Sign in again** | Your session expired. | Sign in, then reopen the screen. |
| **Can't reach your hub** | The phone could not reach the hub (network, tunnel). | Check the connection and the hub address; try again. |
| **The agent's computer is offline** | The machine running the connector is not connected to the hub. | Start the connector on that machine (`foxfleet connector run`), see [Machines](/agents/real-machine). |
| **No VNC on this machine** / **not installed** | Hermes cannot start a virtual desktop there. | Install the display packages; see [Screen takeover setup](/agents/screen-setup). The message lists what is missing. |
| **Hermes is too old** | The agent's Hermes has no display feature. | Update Hermes. |
| **Still starting** (timeout) | A first start boots a desktop (Xvnc, a window manager), which can take up to a minute. | Wait and tap **Try again**. |
| **Session expired, reopening** | Hermes restarted its gateway and forgot the viewer. | The app reopens it for you once; otherwise tap **Reopen**. |
| **Your hub needs an update** | The hub is older than 0.3.5 and cannot say why a screen failed. | Update the hub (see [compatibility](/hosting/upgrading#compatibility)). |
| **The viewer did not start** | The in-app viewer page never reported ready (Android WebView problem). | Update Android System WebView, then retry. Tell us the Android version. |

Behind Cloudflare, WebSockets must be allowed (they are by default) and the connector must reach the hub over `wss://`.

Why this is safe: [Takeover safeguards](/security/takeover).

::: warning Status
Screen takeover is covered by automated tests: a real Xvfb + x11vnc behind a fake Hermes dashboard, driven by Chrome with the Android viewer page served from the app's asset origin. It has **not** been verified on a physical Android device or the Android emulator in this repository's current state.
:::
