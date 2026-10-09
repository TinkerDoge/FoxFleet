# Migrating an existing AgentsHub deployment (the maintainer's own install)

Foxfleet is the new name of AgentsHub. There are **no compatibility shims**: old names stop working, so rename once.

## 1. Environment variables

Rename every `AGENTSHUB_*` to `FOXFLEET_*` in the service unit or env file:

| Old | New |
| --- | --- |
| `AGENTSHUB_PASSWORD` | `FOXFLEET_PASSWORD` |
| `AGENTSHUB_HOST` / `AGENTSHUB_PORT` | `FOXFLEET_HOST` / `FOXFLEET_PORT` (or `PORT`) |
| `AGENTSHUB_CONFIG` | `FOXFLEET_CONFIG` |
| `AGENTSHUB_TRUSTED_ORIGINS` | `FOXFLEET_TRUSTED_ORIGINS` |
| `AGENTSHUB_SETUP_CODE` | `FOXFLEET_SETUP_CODE` |
| `AGENTSHUB_TOKEN` (connector) | `FOXFLEET_TOKEN` |

## 2. Data directory

`config.json` (format **v3**) is unchanged and stays compatible; so do `accounts/`, `users/` and `inbox.json`. Only the location changes if you want it to:

```bash
systemctl --user stop agentshub
tar czf ~/agentshub-data-backup.tgz -C <old data dir> .          # keep this until everything works
mkdir -p ~/.local/share/foxfleet && cp -a <old data dir>/. ~/.local/share/foxfleet/
```

Point `FOXFLEET_CONFIG` at `~/.local/share/foxfleet/config.json`. (Or keep the old directory and just set `FOXFLEET_CONFIG` to the existing file.)

## 3. Service and code

```bash
git clone <foxfleet repo> ~/foxfleet && (cd ~/foxfleet/web && npm ci && npm run build)
cp ~/foxfleet/deploy/foxfleet.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user disable agentshub && systemctl --user enable --now foxfleet
```

Cloudflare Tunnel: no change if the ingress still points at `http://127.0.0.1:3080` (the hostname is your own).

## 4. Things that change for users

- **Sessions:** the cookie is now `foxfleet_session`, so everyone signs in once more. Accounts and passwords carry over.
- **Connectors:** download the new script (`https://<hub>/connector.mjs`, now `foxfleet-connector.mjs`) and restart it with `FOXFLEET_TOKEN`. Existing connector tokens stay valid.
- **Android:** the new app id is `dev.foxfleet.app` (app name Foxfleet, deep link `foxfleet://connect`). It installs **next to** the old AgentsHub app; sign in again and delete the old app when ready. The old `agentshub://` links stop working.
- **Web:** the old browser UI is gone; the new web app is served by the hub.
- **Agents' bootstrap prompts** mention the hub address and `foxfleet-connector.mjs`; regenerate them from the app if you saved old ones.

## 5. Rollback

Stop `foxfleet`, restore the tarball, start the old `agentshub` unit from the old checkout. Data written by Foxfleet stays readable by the last AgentsHub (config v3).
