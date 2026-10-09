# 5-minute quick start

You need one always-on machine for the **hub** (a small VPS, NAS, mini PC or old laptop) and, later, the Android app.

::: warning Status: partly unverified
The Node path below is what the project's CI and the deploy script exercise. The Docker path follows the repository's `Dockerfile` and `compose.yaml`, but **the image build has not been run end to end** by the maintainers yet. If it breaks, [open an issue](https://github.com/TinkerDoge/FoxFleet/issues).
:::

## Option A: plain Node (22 or newer)

```bash
git clone https://github.com/TinkerDoge/FoxFleet.git foxfleet && cd foxfleet
(cd web && npm ci && npm run build)      # builds web/dist, which the hub serves
node server/index.js
```

The hub listens on `127.0.0.1:3080` and stores its data next to `server/config.json` unless you set `FOXFLEET_CONFIG`. Open <http://127.0.0.1:3080>.

On a loopback bind **no setup code is needed**: the first screen creates the owner account.

To reach the hub from other machines, bind a non-loopback address and read the setup code from the log:

```bash
FOXFLEET_HOST=0.0.0.0 node server/index.js
# Foxfleet listening on 0.0.0.0:3080
# First-run setup code (needed to create the owner account): <code>
```

Do not expose plain http to the internet: put [Caddy/nginx](/hosting/reverse-proxy) or a [Cloudflare Tunnel](/hosting/cloudflare-tunnel) in front.

## Option B: Docker Compose

```bash
git clone https://github.com/TinkerDoge/FoxFleet.git foxfleet && cd foxfleet
cp deploy/env.example .env     # optional: set FOXFLEET_TRUSTED_ORIGINS to your public https origin
docker compose up -d --build
docker compose logs foxfleet | grep "setup code"
```

The container binds `0.0.0.0` internally (so it prints a setup code); compose publishes it on `127.0.0.1:3080` only. Data lives in the `foxfleet-data` volume. See [Docker Compose](/hosting/docker).

## Create the owner and sign in

1. Open the hub in a browser. A fresh hub shows **Set up your hub**.
2. Enter the setup code (if one was printed), a username (3–32 letters, digits, `.` `_` `-`) and a password of at least 10 characters.
3. You are signed in as **owner**. Details in [First run](/guide/first-run).

## Add your first agent

Sidebar → **Manage agents → Add**. The simplest first agent is an API-key provider such as [OpenRouter](/agents/openrouter): pick the type, paste the key, **Test connection**, **Save**. Then open it from the sidebar and chat.

## Connect a computer that runs Hermes

Sidebar → **Manage agents → Machines → Connect a machine**. Paste the one line it shows into a terminal on the computer with Hermes (Node.js 22+ needed), tick the profiles to share, and the app reports *Found 3 profiles: default, coder, research*. Full guide: [Connect a real machine](/agents/real-machine).

## Put the app on your phone

1. Install the Android app ([guide](/guide/android)).
2. In the web app open **Admin → Pair a phone**; it shows a QR code for `foxfleet://connect?hub=…`.
3. In the app's first screen tap **Scan QR** (or tap the link on the phone, or type the hub address). Sign in with your account.

::: tip Public address needed for phones
Phones need to reach your hub. On the same Wi-Fi you can use a LAN address (the app asks you to switch on *Allow http on this network*). Anywhere else use an https address through a [tunnel](/hosting/cloudflare-tunnel) or [reverse proxy](/hosting/reverse-proxy).
:::
