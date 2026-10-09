# The `foxfleet` command

`foxfleet` is a small admin tool for the machine that runs your hub. It ships in the server package (`server/bin/foxfleet`), is plain Node (22+) with no dependencies, and works over SSH. It is meant for: checking that a hub is healthy, updating safely, backups, and fixing accounts when you are locked out.

::: warning Status
New in 0.2.1-alpha. It is covered by automated tests (including `doctor` and `update` against a mock release server), but has not yet been run against a real GitHub release or on macOS/Windows. The systemd commands need a Linux `systemd --user` install.
:::

## Install

Pin the installer to a **release tag**, not to the `main` branch, so you run exactly the script that was released and the version you chose (replace the tag with the release you want; see [Releases](https://github.com/TinkerDoge/FoxFleet/releases)):

```bash
TAG=v0.2.1-alpha
curl -fsSL "https://raw.githubusercontent.com/TinkerDoge/FoxFleet/$TAG/deploy/install.sh" -o install.sh
less install.sh                      # it is short; read it
FOXFLEET_VERSION="${TAG#v}" sh install.sh
```

Piping straight into `sh` works too (`curl -fsSL …/$TAG/deploy/install.sh | FOXFLEET_VERSION=… sh`), but downloading first lets you read it. The script writes only under your home folder, needs no root, unpacks to `~/.local/share/foxfleet-app/<version>/`, points `current` at it and links `~/.local/bin/foxfleet`. Add `~/.local/bin` to your `PATH` if it is not there. Without `FOXFLEET_VERSION` it installs the newest release including pre-releases. Options (environment): `FOXFLEET_VERSION`, `FOXFLEET_APPS_DIR`, `FOXFLEET_BIN_DIR`.

::: warning What the checksum check does and does not protect
The installer and `foxfleet update` verify the tarball against the `SHA256SUMS` file **from the same GitHub release**. That catches a corrupted or truncated download and a mismatched asset. It does **not** protect against a compromised release or maintainer account, because an attacker who can replace the tarball can replace `SHA256SUMS` too, and the server tarball is not signed. Only the Android APK carries a signature (see [Security](/security/)). For a stricter check, compare the SHA-256 with a value the maintainers published somewhere else (for example the release notes or a signed tag) before you run `update`.
:::

Already run from a git checkout or a Docker image? Run it directly: `node server/bin/foxfleet doctor` (or `docker compose exec foxfleet node server/bin/foxfleet doctor`). `update` only manages installer-style folders; git checkouts use `deploy/deploy.sh`.

## Commands

| Command | What it does |
| --- | --- |
| `foxfleet doctor [--url https://hub.example] [--offline]` | Checks Node version, `web/dist`, data dir (exists, writable, private, free disk), `config.json` and accounts validity, whether the hub answers on its port, bind address, `FOXFLEET_TRUSTED_ORIGINS`, the public URL, whether a WebSocket upgrade gets through, the systemd unit (active, enabled, lingering), this computer's connector, backup age and your version against the latest release. Every problem prints a **fix**. |
| `foxfleet update [--check] [--dry-run] [--version X] [--stable]` | Reads the GitHub releases, downloads `foxfleet-server-<v>.tar.gz` and `SHA256SUMS`, **verifies the checksum**, backs up your data, unpacks beside the old version, switches `current`, restarts the unit, waits for `/health` and **rolls back automatically** (code and data) if it does not come up. Pre-releases are included unless you pass `--stable`. `--check` exits `10` when an update exists. |
| `foxfleet status` | Running or not, port, service state, data dir, number of users and machines. |
| `foxfleet start \| stop \| restart` | Controls the `systemd --user` unit (`FOXFLEET_UNIT`, default `foxfleet`) and waits for health. `start --foreground` runs the hub in your terminal. |
| `foxfleet logs [--follow] [--lines N]` | `journalctl` for the unit. |
| `foxfleet setup --show-code` | First run: prints the one-time setup code from the log (or from `FOXFLEET_SETUP_CODE`). |
| `foxfleet setup --username NAME` | Creates the owner here instead of in the browser. The password comes from the prompt, `--password-stdin` or `FOXFLEET_PASSWORD`. Never from a flag. |
| `foxfleet user list \| add NAME \| disable NAME \| enable NAME \| reset-password NAME` | Account recovery and admin. `reset-password` signs that person out everywhere. |
| `foxfleet invite create [--ttl HOURS] [--url https://hub.example]` | Prints a single-use invite code (and a ready link with `--url`). |
| `foxfleet backup [--to FILE]` / `foxfleet restore [FILE] [--yes]` | One `0600` tarball of `config.json`, accounts, machines and history. Restore first saves the current state as `pre-restore-*.tar.gz` and refuses archives with unexpected paths. |
| `foxfleet config get [KEY] \| set KEY VALUE \| path` | Reads and writes the environment file the systemd unit loads (`~/.config/foxfleet/env`, mode 0600). Secrets print as `(set)` unless `--reveal`. Restart to apply. |
| `foxfleet connector pair \| install-service \| status \| rescan \| uninstall` | Runs this computer's [connector](/concepts/connector) from the same install (`pair --hub URL --code CODE`). |
| `foxfleet version`, `foxfleet completion bash \| zsh` | `eval "$(foxfleet completion bash)"` in your shell profile. |

### Changing accounts while the hub runs

The hub holds accounts in memory, so a file edited underneath it would be overwritten. `setup`, `user …`, `invite create` and `restore` therefore **stop the systemd unit, make the change and start it again** (a few seconds). If the hub runs some other way, the command refuses unless you pass `--force`.

## Scripting

- `--json` prints one JSON document (errors as `{"error": "…", "fix": "…"}`). Colour only appears on a terminal and honours `NO_COLOR`.
- Exit codes: `0` ok · `1` failed, or `doctor` found a failure (warnings alone exit 0) · `2` usage error · `3` not supported for this install · `10` `update --check` found an update.
- Nothing prompts when there is no terminal: missing secrets are an error (`2`), `restore` needs `--yes`.

```bash
foxfleet update --check --json && echo "up to date"
foxfleet doctor --json | jq -r '.checks[] | select(.status!="ok") | "\(.status): \(.message)"'
```

## Settings it reads

`FOXFLEET_DATA`, `FOXFLEET_CONFIG`, `FOXFLEET_PORT`/`PORT`, `FOXFLEET_HOST`, `FOXFLEET_UNIT`, `FOXFLEET_BACKUPS`, `FOXFLEET_ENV_FILE`, `FOXFLEET_PUBLIC_URL`, `FOXFLEET_TRUSTED_ORIGINS`, `FOXFLEET_SETUP_CODE` (from the environment first, then the env file) and, for mirrors and tests, `FOXFLEET_RELEASES_API`, `FOXFLEET_APPS_DIR`.
