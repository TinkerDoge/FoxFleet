# Migrating from AgentsHub

Foxfleet is the new name of **AgentsHub** (the maintainer's earlier private project). If you ran AgentsHub you must rename things once; **there are no compatibility shims**. If you are new, skip this page.

## 1. Environment variables

| Old | New |
| --- | --- |
| `AGENTSHUB_PASSWORD` | `FOXFLEET_PASSWORD` |
| `AGENTSHUB_HOST` / `AGENTSHUB_PORT` | `FOXFLEET_HOST` / `FOXFLEET_PORT` (or `PORT`) |
| `AGENTSHUB_CONFIG` | `FOXFLEET_CONFIG` |
| `AGENTSHUB_TRUSTED_ORIGINS` | `FOXFLEET_TRUSTED_ORIGINS` |
| `AGENTSHUB_SETUP_CODE` | `FOXFLEET_SETUP_CODE` |
| `AGENTSHUB_TOKEN` (connector) | `FOXFLEET_TOKEN` |

## 2. Data

`config.json` (format **v3**), `accounts/`, `users/` and `inbox.json` are unchanged and compatible. Back up, then copy or point `FOXFLEET_CONFIG` at the existing file:

```bash
systemctl --user stop agentshub
tar czf ~/agentshub-data-backup.tgz -C <old data dir> .
mkdir -p ~/.local/share/foxfleet && cp -a <old data dir>/. ~/.local/share/foxfleet/
```

## 3. Service and code

```bash
git clone https://github.com/TinkerDoge/FoxFleet.git ~/foxfleet && (cd ~/foxfleet/web && npm ci && npm run build)
cp ~/foxfleet/deploy/foxfleet.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user disable agentshub && systemctl --user enable --now foxfleet
```

A Cloudflare Tunnel ingress that points at `http://127.0.0.1:3080` needs no change.

## 4. What users notice

- **Sessions:** the cookie is now `foxfleet_session`, so everyone signs in once more. Accounts and passwords carry over.
- **Connectors:** download the new script (`https://<hub>/connector.mjs`, saved as `foxfleet-connector.mjs`) and restart it with `FOXFLEET_TOKEN`. Existing connector tokens stay valid.
- **Android:** new app id `dev.foxfleet.app`, installs **next to** the old app; deep link is `foxfleet://connect` (the old `agentshub://` links stop working). Sign in again, then delete the old app.
- **Web:** the old browser UI is gone; the new web app is served by the hub.

## 5. Rollback

Stop `foxfleet`, restore the tarball, start the old `agentshub` unit from the old checkout. Data written by Foxfleet stays readable by the last AgentsHub (config v3).
