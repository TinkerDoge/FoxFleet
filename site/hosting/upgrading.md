# Upgrading and rollback

## With the `foxfleet` command (installer installs)

If you installed with `deploy/install.sh` (see the [CLI reference](/reference/cli)):

```bash
foxfleet update --check       # exit 10 when a newer release exists
foxfleet update --dry-run     # show the plan
foxfleet update               # verify checksum, back up, swap, restart, health-check, roll back on failure
```

Updating never deletes the old version folder, so you can also point `current` back by hand. Git checkouts and Docker use the sections below.

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


## Compatibility

Apps and connectors keep working with an older hub and tell you what is missing (Settings shows a quiet "Update your hub" note; a card or a screen error names the feature). Hubs older than 0.3.5 report no version.

| Feature | Needs hub | Needs connector | Needs app |
| --- | --- | --- | --- |
| Chat, sessions, commands | any 0.3.x | 0.3.x | any |
| Agent media cards (`MEDIA:`), image proxy | 0.3.3 | 0.3.3 | 0.3.3 |
| Media from tool results, `data:` pictures, "outside shared folders" reason + fix | **0.3.5** | 0.3.3 (`allow-media`, doctor media rows and the Media row's connector version need **0.3.5**) | 0.3.5 |
| Last-activity time and preview on agent cards | 0.3.4 (seeding from existing Hermes chats: **0.3.5**) | none | 0.3.4 (offline fallback: 0.3.5) |
| Screen takeover | 0.3.x | 0.3.x, Hermes with display support | any |
| Screen errors that say why (machine offline, hub too old, …) | **0.3.5** | none | 0.3.5 |
| Version and feature report (`/api/auth` `hub`) | **0.3.5** | none | 0.3.5 |

The hub's features (`GET /api/auth` → `hub.features`): `screenErrors`, `media`, `mediaTags`, `agentActivity`, `pin`, `hubInfo`. To upgrade the hub, follow the steps above and redeploy: a build from before 0.3.5 will not report them.
