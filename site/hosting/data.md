# Data directory layout

The data directory is **the folder that contains `config.json`**, i.e. the parent of `FOXFLEET_CONFIG` (`~/.local/share/foxfleet` for systemd, `/data` in Docker, `server/` if you set nothing).

```text
<data dir>/
├── config.json              owner's agent registry, format v3 (mode 0600)
├── config.json.v<N>.bak     one backup per automatic migration from an older format
├── accounts/
│   ├── users.json           usernames, roles, scrypt hashes, disabled flags
│   ├── devices.json         sign-in sessions (token hashes, never tokens)
│   ├── invites.json         open invites (hashed codes)
│   └── account-settings.json  registration mode
├── users/<user id>/         one folder per non-owner user
│   └── config.json          their agent registry
└── backups/                 created by deploy/deploy.sh (tarballs, mode 0600)
```

Older hubs also wrote `inbox.json` (MCP-inbox mailboxes) and `history.json` (API-key chat history). The current hub no longer reads them; they stay where they are and `foxfleet backup` still includes them.

What is **not** here: chat history (Hermes keeps it), uploaded files (they are streamed to the agent's own upload folder), and the web app (`web/dist`, rebuilt from source).

`config.json` is written atomically (temp file + rename, mode 0600) and refused above 1 MiB or 32 agents. Everything in this directory is sensitive: it contains agent credentials in `config.json` files and password hashes.
