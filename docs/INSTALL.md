# Install

You need a machine that stays on (a small server, NAS or old PC) and Node 22+ or Docker. Agents and phones connect to it.

## Docker

```bash
git clone <repo> foxfleet && cd foxfleet
cp deploy/env.example .env     # optional: set FOXFLEET_TRUSTED_ORIGINS to your public https address
docker compose up -d --build
docker compose logs foxfleet | grep "setup code"
```

Data (config, accounts, keys) lives in the `foxfleet-data` volume. Back it up.

## systemd (no Docker)

```bash
git clone <repo> ~/foxfleet && cd ~/foxfleet
(cd web && npm ci && npm run build)          # builds web/dist, served by the hub
mkdir -p ~/.local/share/foxfleet ~/.config/foxfleet ~/.config/systemd/user
cp deploy/env.example ~/.config/foxfleet/env && chmod 600 ~/.config/foxfleet/env
cp deploy/foxfleet.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user enable --now foxfleet && loginctl enable-linger "$USER"
journalctl --user -u foxfleet | grep "setup code"
```

Update later with `deploy/deploy.sh` (backup, tests, web build, restart, health check, automatic rollback).

## First run

1. Open the hub in a browser (or the app) and **create the owner** with the one-time setup code. (On a loopback-only bind no code is needed.)
2. **Admin** (owner only): registration is **closed** by default. Switch to *Invite* and create invite links for other people.
3. **Pair a phone**: Admin shows a QR for `foxfleet://connect?hub=...`. In the Android app choose *Scan QR*, or just type the address.
4. **Add agents**: Settings > Manage agents. API-key providers need only a key. For a Hermes machine, create a *connector* agent, copy the bootstrap prompt to that machine ([CONNECT-AGENT.md](CONNECT-AGENT.md)).

## Publishing on the internet

Use a reverse proxy with https or a Cloudflare Tunnel ([deploy/cloudflare-tunnel.md](../deploy/cloudflare-tunnel.md)). Set `FOXFLEET_TRUSTED_ORIGINS` to the public origin. The apps refuse plain http for public addresses.

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `FOXFLEET_HOST` / `PORT` | Bind address and port | `127.0.0.1` / `3080` |
| `FOXFLEET_CONFIG` | Path of `config.json` (other data lives beside it) | `server/config.json` |
| `FOXFLEET_TRUSTED_ORIGINS` | Comma-separated public origins allowed for cookie sessions | the bind address |
| `FOXFLEET_PASSWORD` | Create the first owner (`owner`) from this password | unset (use the setup code) |
| `FOXFLEET_SETUP_CODE` | Fix the one-time setup code instead of a random one | random |
| `FOXFLEET_WEB_DIR` | Directory with the built web app | `web/dist` |
