# Backups and restore

Back up the **data directory** ([layout](./data)). Nothing else is state.

## Manual

```bash
systemctl --user stop foxfleet                      # optional but gives a consistent copy
tar czf foxfleet-backup-$(date +%F).tgz -C ~/.local/share/foxfleet config.json* accounts users inbox.json
chmod 600 foxfleet-backup-*.tgz
systemctl --user start foxfleet
```

Treat the tarball like a password vault: it holds API keys and password hashes. Encrypt it before it leaves the machine (`age`, `gpg`).

## Automatic (deploy script)

`deploy/deploy.sh` writes `pre-deploy-<timestamp>.tar.gz` (mode 0600, in `<data>/backups`) before every deploy and uses the latest one for `--rollback`. See [Upgrading and rollback](./upgrading). It is not a scheduled backup: run your own cron or timer for that.

## Restore

```bash
systemctl --user stop foxfleet
cd ~/.local/share/foxfleet && rm -rf accounts users && tar xzf /path/to/backup.tgz
systemctl --user start foxfleet
curl -fsS http://127.0.0.1:3080/health
```

Everyone stays signed in only if `accounts/devices.json` is restored too (it is part of `accounts/`). Connector tokens are in `config.json`, so connectors reconnect without changes.

## Docker volume

```bash
docker run --rm -v foxfleet_foxfleet-data:/data -v "$PWD":/out alpine tar czf /out/data.tgz -C /data .
```

(The volume is named `<compose project>_foxfleet-data`; check with `docker volume ls`.)
