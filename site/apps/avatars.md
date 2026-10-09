# Avatars

## What an avatar looks like today

- **Default:** a circle with the agent's initials on a stable pastel tint (the same colour for the same name on every screen), plus a presence dot: ready, online or offline.
- **Android custom avatar:** in a chat, **long-press the avatar** in the header, pick a picture, then pan and zoom it inside the circle cropper. The result is stored **on that phone only** (512 px square WebP in the app's private storage); the hub never sees it. *Reset* returns to the default.
- **Web:** shows the default avatar; custom avatars are not available yet.

## Hub avatar packs (server feature, no client yet)

The hub can serve animated avatar packs from `web/dist/avatars/<AgentId>/` (override with `FOXFLEET_WEB_DIR`): files named `idle`, `working`, `offline`, `making_something` and `milestone_level_up` with a `.webm`, `.mp4`, `.m4v` or `.mov` extension, plus an optional `poster.png/jpg/webp/avif`. `GET /api/avatars` lists the packs found (up to 32 agents). The agent form's **Avatar hint** field (a pack name or an emoji) is stored with the agent for this purpose.

::: info Status
The current web and Android clients do not yet render packs or the avatar hint; only the Android on-device custom avatar is used. The server side and its tests exist so clients can adopt them.
:::
