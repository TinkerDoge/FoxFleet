# Connect a real machine

Connecting a computer that runs [Hermes](./hermes) takes one command, however many Hermes profiles it has. You do it once per **machine**, not once per agent.

::: tip The five steps
1. In the app open **Manage › Machines › Connect a machine** (web or Android).
2. Copy the one-line command (or scan the QR with your phone camera and open the link in the machine's browser).
3. Paste it into a terminal on the computer that runs Hermes.
4. Tick the profiles you want to share.
5. Watch the app say **Found 3 profiles: default, coder, research**. They are now agents.
:::

## What you need

- A hub you can sign in to as the owner ([quick start](/guide/quick-start)).
- Node.js **22 or newer** on the machine (`node -v`). Nothing else is installed.
- Hermes already installed there (`~/.hermes`, or `%LOCALAPPDATA%\hermes` on Windows).

## The command

The hub makes a **pairing code**: 10 characters (shown like `K7QMX-2PD4H`), valid for **15 minutes**, usable **once**, and tied to your account.

| Where | Command |
| --- | --- |
| macOS, Linux, WSL | `curl -fsSL https://your-hub/c/<code> \| sh` |
| Windows PowerShell | `irm https://your-hub/c/<code>.ps1 \| iex` |
| Node only (no pipe to a shell) | `curl -fsSL https://your-hub/connector.mjs -o foxfleet-connector.mjs && node foxfleet-connector.mjs pair --hub https://your-hub --code <code>` |

The script is short and readable: open the same URL in a browser to read it before running it. It checks for Node 22, downloads `connector.mjs` from your hub into `~/.foxfleet/connector/`, and runs `pair`. Opening the URL does **not** use the code up.

The **magic link** `foxfleet://pair?hub=…&code=…` opens the Android app on its pairing screen (when you are signed in), which shows the same command, code and QR. The **QR code** contains the https link, so a phone camera or any scanner opens it in a browser.

::: info Copy this prompt to your agent
If your Hermes agent can run shell commands, give it this and let it do the typing:

> Run this command on this computer and answer its questions: `curl -fsSL https://your-hub/c/<code> | sh`

The app has a button for this (**Or tell your agent** on the web, **Copy as a prompt** on Android).
:::

## What the connector asks

```
Paired as "workstation".

Hermes profiles found on this computer:
  1. [x] default
  2. [x] coder
  3. [x] research
Numbers toggle (e.g. 1 3), a = all, n = none, Enter = continue:
Keep Foxfleet connected in the background (start automatically)? [Y/n]
```

Non-interactive: `--all` shares every profile, `--profiles default,coder` shares those. Without a terminal it shares everything it finds. Each profile becomes its own agent named after the profile (`default`, `coder`, `research`); if a name is already taken on your hub it becomes `coder-2`.

## Keeping it running

Answer **Y** to the background question, or run `node foxfleet-connector.mjs install-service` later:

| System | What it installs | Remove |
| --- | --- | --- |
| Linux | a `systemd --user` unit `foxfleet-connector.service` (add `sudo loginctl enable-linger $USER` to start at boot without logging in) | `uninstall-service` |
| macOS | a launchd agent `dev.foxfleet.connector` | `uninstall-service` |
| Windows | a scheduled task `FoxfleetConnector` (runs at logon). For a real Windows service use [NSSM](https://nssm.cc): `nssm install FoxfleetConnector node.exe foxfleet-connector.mjs run` | `uninstall-service` |

New or removed Hermes profiles are noticed when the connector restarts and every 5 minutes. A new profile is **not** shared automatically; the connector prints a hint and you choose with `node foxfleet-connector.mjs profiles`. A profile deleted in Hermes disappears from the app.

## Manage machines

**Manage › Machines** lists every machine with online/offline, its profiles and when it was last seen. No addresses are shown.

- **Rename** a machine.
- **Re-pair** rotates its token: the old token stops working immediately, the machine goes offline, and you get a fresh code. Pairing again keeps the same machine and its agents.
- **Revoke** removes the machine and all of its agents; its token is dead from that moment. Run `node foxfleet-connector.mjs unpair` on the machine to clean up the local file and service.

## Connector commands

| Command | What it does |
| --- | --- |
| `pair --hub URL --code CODE` | Pair once, choose profiles, optionally install the service. Flags: `--name`, `--all`, `--profiles a,b`, `--install-service`, `--no-run`, `--hermes-home DIR`, `--dashboard-port N`. |
| `run` | Stay connected (what the service runs). |
| `profiles` | Change which profiles are shared (`--all`, `--profiles a,b`). |
| `status` | Show the machine name, hub and which profiles are shared. |
| `install-service` / `uninstall-service` | Start at login / remove that. |
| `unpair` | Forget this machine locally and remove the service. |

## Troubleshooting

| You see | Try |
| --- | --- |
| *Node 22 or newer is required* | Install Node 22+ from nodejs.org, or with `nvm install 22`. |
| *That pairing code is wrong, already used or expired* | Codes live 15 minutes and work once. Make a new one in the app. After 8 wrong tries from one address the hub makes you wait. |
| *Could not reach the hub* | The machine must reach your hub's **public https address** (the one in the command). Check it in a browser on that machine. |
| *Refusing plain http://…* | Use an https hub. For a trusted LAN only: `FOXFLEET_ALLOW_INSECURE_HUB=1`. |
| *No Hermes profiles found* | Hermes is not in `~/.hermes` for this user. Run as the same user as Hermes, or pass `--hermes-home /path`. |
| Profiles shared but agent is *offline* / not chat-ready | Start the Hermes dashboard and gateway on the machine; the connector only forwards to them on `127.0.0.1`. See [Hermes](./hermes). |
| *dashboard password is stored hashed* | Hermes only keeps a hash, so sign-in cannot be automated. Set `FOXFLEET_DASHBOARD_PASSWORD_<PROFILE>` (upper-case, `-` as `_`) in the connector's environment. |
| *The hub keeps refusing this machine* | It was revoked or re-paired. Create a new code and run `pair` again. |
| A new profile does not show up | Run `node foxfleet-connector.mjs profiles` and tick it. |

## Settings on the machine

Everything is optional; pairing needs only the hub and the code. The connector's own file is `connector.json` in `~/.config/foxfleet` (macOS `~/Library/Application Support/foxfleet`, Windows `%APPDATA%\foxfleet`), mode `0600`; set `FOXFLEET_CONFIG_DIR` to move it. It scans `~/.hermes` (Windows `%LOCALAPPDATA%\hermes`, or `HERMES_HOME` / `FOXFLEET_HERMES_HOME`) and assumes Hermes' dashboard on port `9119` (`FOXFLEET_DASHBOARD_PORT` or `--dashboard-port`). In `connector.json`, `profiles.<name>` may carry `apiPort`, `dashboardPort`, `dashboardUser`, `dashboardPassword` for a profile that runs its own gateway or keeps only a hashed password. The connector variables the hub docs list in [Environment variables](/hosting/environment) are `FOXFLEET_HUB`, `FOXFLEET_CODE` and `FOXFLEET_ALLOW_INSECURE_HUB`.

## Not Hermes?

Chat providers (OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok) need no machine at all: add them with an API key. Muse and other mailbox agents use the [MCP inbox](./mcp-inbox), unchanged. For other **local agents** the same machine connector is the intended carrier; see [Write your own plugin](./write-a-plugin#local-agents-through-a-machine) for the extension point.
