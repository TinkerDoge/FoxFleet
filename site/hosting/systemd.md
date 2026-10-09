# Linux with systemd

A **user** service keeps everything under your home directory (no root). From the repository's `deploy/foxfleet.service`:

```bash
git clone https://github.com/TinkerDoge/FoxFleet.git ~/foxfleet && cd ~/foxfleet
(cd web && npm ci && npm run build)          # builds web/dist, served by the hub
mkdir -p ~/.local/share/foxfleet ~/.config/foxfleet ~/.config/systemd/user
cp deploy/env.example ~/.config/foxfleet/env && chmod 600 ~/.config/foxfleet/env
cp deploy/foxfleet.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user enable --now foxfleet
loginctl enable-linger "$USER"                # keep it running when you log out
# only if you bind a non-loopback address: journalctl --user -u foxfleet | grep "setup code"
```

Edit `~/.config/foxfleet/env` (mode 600; everything is optional):

```ini
FOXFLEET_HOST=127.0.0.1
PORT=3080
FOXFLEET_TRUSTED_ORIGINS=https://hub.example.com
# FOXFLEET_PASSWORD=       # create the owner from a password instead of the setup code
# FOXFLEET_WEB_DIR=
```

## The unit file

```ini
[Service]
Type=simple
WorkingDirectory=%h/foxfleet
EnvironmentFile=-%h/.config/foxfleet/env
Environment=FOXFLEET_CONFIG=%h/.local/share/foxfleet/config.json
Environment=PORT=3080
ExecStart=/usr/bin/env node server/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=%h/.local/share/foxfleet
```

`ProtectSystem=strict` makes the filesystem read-only except the data directory. If your Node lives somewhere unusual, change `ExecStart` to its absolute path.

## Logs and health

```bash
journalctl --user -u foxfleet -f
curl -fsS http://127.0.0.1:3080/health        # {"ok":true}
```

Updating: [Upgrading and rollback](./upgrading).


## The `foxfleet` command

`foxfleet start|stop|restart|logs|status|doctor` wrap the unit above and `foxfleet config set` edits its environment file. See the [CLI reference](/reference/cli).
