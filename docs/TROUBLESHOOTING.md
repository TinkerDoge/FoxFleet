# Troubleshooting

## The bot computer view is black
1. Open the screen and wait about 10 s. If it says **"the machine's screen is empty"**, the connection works but the remote virtual desktop has nothing on it (no window manager or wallpaper). Tap **Restart desktop**. If it stays empty, install a desktop on that machine (for example `xfce4`) and restart again.
2. **"No picture arrived"**: tap **Reconnect**; check that a VNC server is installed (`foxfleet-connector doctor`).
3. Still black with no message: Settings > **Screen debug** (or long-press the title), reproduce, tap **Send diagnostics** and paste the report. It shows state, size, frames received, last error and WebView console lines (also in `adb logcat -s FoxfleetScreen`).
4. Update Android System WebView / Chrome; very old WebViews cannot run the viewer and say so.

## An agent says it is in a terminal / MEDIA does not work
Run `foxfleet-connector doctor --fix` on the machine; see AGENT-AWARENESS.md.

## A picture I sent does not show
Update hub and connector to 0.3.6. The tile shows **Retry** when it cannot be loaded.
