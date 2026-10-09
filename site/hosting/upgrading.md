# Upgrading and rollback

## With the deploy script (systemd installs)

`deploy/deploy.sh` runs **on the hub host**. Site-specific values come from the environment or a gitignored `deploy/deploy.local.env` (copy `deploy.local.env.example`):

| Setting | Default |
| --- | --- |
| `FOXFLEET_SRC` | `$HOME/foxfleet` (the git checkout) |
| `FOXFLEET_DATA` | `$HOME/.local/share/foxfleet` |
| `FOXFLEET_HEALTH` | `http://127.0.0.1:3080/health` |
| `FOXFLEET_UNIT` | `foxfleet` (the `systemd --user` unit) |
| `FOXFLEET_BACKUPS` | `<data>/backups` |
| `FOXFLEET_SKIP_WEB=1` | skip the web build (when `dist/` is shipped prebuilt) |
| `NODE`, `NPM` | `node`, `npm` |

```bash
deploy/deploy.sh --dry-run            # checks tools, data dir, prints the plan, runs server tests; changes nothing
deploy/deploy.sh                      # deploy origin/main
deploy/deploy.sh v0.1.2               # or any git ref
deploy/deploy.sh --rollback <ref>     # restore the latest pre-deploy backup and that code
```

A deploy: `git fetch` → back up the data → check out the ref → run the hub tests (abort on failure) → build the web app → restart the unit → poll `/health` for about 12 s → **automatic rollback** to the previous commit and data if it is not healthy.

Config-format changes migrate automatically on start and leave a `config.json.v<N>.bak`.

::: warning Status
`--dry-run` was exercised on the maintainers' build host. The full deploy and rollback paths follow the same script but have not been run against a production hub with the new name yet.
:::

## Docker

```bash
git pull && docker compose up -d --build
```

The `foxfleet-data` volume is kept. Back it up first ([how](./backups)). Rolling back means checking out the previous commit and rebuilding, restoring the volume if the data format changed.

## Compatibility promise (alpha)

`config.json` v3 is stable within `0.1.x`. Until `1.0` there is no guarantee for other files; read the [changelog](/project/changelog) before upgrading.
