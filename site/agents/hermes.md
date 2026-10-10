# Hermes

Hermes is the agent kind with the most features: chat, images, files, skills, sessions, voice and the desktop screen. A Hermes install exposes a **dashboard** (default `127.0.0.1:9119`) and a **chat API** (default `127.0.0.1:8642`) on the machine it runs on. Several **profiles** can share one install: the default profile lives in `~/.hermes`, named ones in `~/.hermes/profiles/<name>`.

## Recommended: connect the machine

Follow [Connect a real machine](./real-machine): one command, one connector per computer, every profile you tick becomes an agent. Nothing on the machine listens for the hub and you open no ports.

How the connector finds things (read from the profile's own files, locally):

| What | Where it looks |
| --- | --- |
| Profiles | `default` = the Hermes folder itself (`~/.hermes`, `%LOCALAPPDATA%\hermes`, or `HERMES_HOME`); named profiles = folders in `profiles/` whose name matches `[a-z0-9][a-z0-9_-]*`, that contain a Hermes file (`config.yaml`, `.env`, `SOUL.md`, `profile.yaml`, `auth.json` or `state.db`) and are not deleted (`profiles/.deleted/<name>`) |
| Chat API port and key | the profile's `.env` (`API_SERVER_PORT`, `API_SERVER_KEY`, `API_SERVER_HOST`) or `config.yaml` (`api_server.port`, `api_server.key`); defaults `8642` |
| Dashboard login | `.env` (`HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `…_PASSWORD`) or `config.yaml` (`basic_auth.username` / `password`); dashboard port `9119` (`--dashboard-port` to change) |

Profiles on the same Hermes install normally share one dashboard and one chat API, which tell profiles apart with `?profile=` and `/p/<profile>/`. If a profile runs its own gateway, give it its own ports in the connector's `connector.json` (`profiles.<name>.apiPort`, `dashboardPort`). Those files are on the machine only.

### What crosses the wire

| Goes to the hub | Stays on the machine |
| --- | --- |
| A machine name you chose, the OS family (`linux`, `darwin`, `win32`) | Hermes folder paths, usernames, hostnames |
| The names of the profiles you chose to share | Dashboard passwords, chat API keys, session cookies |
| Your chats, files and screen frames, **while you use** an agent (the hub relays them to your app) | The machine token's plain text is on the machine and in your hub only as a hash |

The hub asks Hermes questions **through** the connector. The connector signs in to the dashboard and adds the API key itself, on `127.0.0.1`, so the hub and your phone never hold those credentials.

## Advanced: direct connection

If the hub can reach the machine itself (same private network, or HTTPS origins you publish), add a **Hermes** agent by hand: **Manage › Add agent › Hermes › Connection: Direct** and enter host, ports and credentials. They are stored on the hub, never shown again, and used only for the hub's own calls. Agents added this way show up and behave like any other, but you maintain the network path yourself.

## Check it works

A healthy agent shows three checks in the app: **Dashboard**, **Management** and **Chat API**. The first fails if Hermes' dashboard is not running; the third if its gateway/API server is not running or the API key is wrong. Screen takeover needs the extra setup in [Screen takeover setup](./screen-setup).

## Troubleshooting

See the table in [Connect a real machine](./real-machine#troubleshooting).

## Native sessions on the machine (optional, recommended)

If the computer running Hermes also has the Hermes checkout, the connector can run Hermes's own session gateway and you get questions and approvals as cards, a live Redirect, a model picker and consistent queueing across devices (see [Chat](../apps/chat.md)). Check it with:

```
foxfleet connector doctor
```

The check lists profiles, shows how the gateway was found, starts it and tells you the fix if it cannot (a missing checkout, or the wrong Python). Without the checkout everything keeps working over HTTP. The command and the discovery order are described in `docs/CONNECT-AGENT.md`.

## Sending pictures, video and files {#sending-pictures-video-and-files}

Agents send media with the usual Hermes `MEDIA:` tag; nothing needs to be configured for files in the profile's cache or workspace folders or the temp folder:

```text
MEDIA:/home/me/.hermes/image_cache/result.png
[[audio_as_voice]]
MEDIA:/tmp/answer.ogg
```

The native Hermes gateway does not interpret the tag (it arrives as text), Foxfleet does. For another folder add it to `mediaRoots` in the connector config (or `FOXFLEET_MEDIA_ROOTS=/data/out:/srv/reports`). See [Pictures, video and files from agents](/apps/agent-media). If a connector link flaps (for example behind Cloudflare) it reconnects by itself and running turns continue; `foxfleet connector doctor` and `foxfleet doctor` show what is wrong when it does not.
