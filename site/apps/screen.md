# Screen takeover

Watch an agent's virtual desktop and, when you choose, drive it. Available for agents with the `screen` capability (Hermes), when the agent reports the display feature is supported ([setup](/agents/screen-setup)).

## Using it

1. Open the agent and tap **Screen**. If the desktop is not running the hub starts it.
2. You are **view only**: you watch, you cannot click or type.
3. **Take over** gives you control. A **red border** and a **countdown to automatic hand-back** appear (15 minutes maximum). On touch screens a **keys row** (Esc, Tab, Enter, arrows, Ctrl+Alt+Del, keyboard) helps.
4. **Hand back** returns control to the agent. It also happens automatically at the deadline, when you leave the screen, and when you close the tab.

## Platform notes

- **Web:** noVNC is lazy-loaded (a separate chunk, only fetched here).
- **Android:** noVNC runs in a locked-down WebView; the window is **`FLAG_SECURE`** while the screen is open, so it cannot be screenshotted or appear in the recents thumbnail.

Why this is safe: [Takeover safeguards](/security/takeover).

::: warning Status
Screen takeover is covered by automated tests with a fake VNC upstream and by mocked-hub browser screenshots. It has not been verified against a real Hermes display or a physical Android device in this repository's current state.
:::
