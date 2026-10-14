# config.json (v3)

One file per user: the owner's is `FOXFLEET_CONFIG`, others live in `users/<id>/config.json` ([layout](/hosting/data)). Mode `0600`, atomic writes, at most 1 MiB and 32 agents.

```json
{
  "version": 3,
  "machines": [
    { "name": "home-hermes", "kind": "hermes", "connection": "connector", "profile": "default",
      "label": "Home", "description": "", "avatar": "🦊",
      "machineId": "<32 hex>",
      "dashboardUser": "admin", "dashboardPass": "…", "apiServerKey": "…" }
  ]
}
```

The array order is the display order. You normally never edit this file by hand; use the apps.

## Common fields

| Field | Type | Rules |
| --- | --- | --- |
| `name` | string | `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`, unique, immutable |
| `kind` | string | `hermes` (missing = `hermes`). Entries of any other kind are ignored, see below. |
| `label` | string | ≤ 64 chars, one line |
| `description` | string | ≤ 280 chars |
| `avatar` | string | ≤ 64 chars (pack name or emoji) |

## `hermes`

| Field | Rules |
| --- | --- |
| `connection` | `connector` or `direct` (default: `direct` if `host` is set, else `connector`); immutable |
| `profile` | id, default `default` |
| machine mode | `machineId` (32 hex); created by a paired machine, holds no credentials |
| direct mode | `host` (IP or DNS name), `dashboardPort` (default 9119), `apiServerPort` (default 8642), optional `dashboardUrl` / `apiServerUrl` (https origin only) |
| credentials | `dashboardUser` (default `admin`), `dashboardPass`, `apiServerKey` (≤ 4096 chars, no control chars), optional `dashboardWsToken` |
| `uploadDir` | absolute or `~/…`, no `..`, ≤ 256 chars |

## Other kinds

Files written by older hubs may hold agents of the removed kinds (`openai`, `openrouter`, `zai`, `opencode`, `grok`, `mcp-inbox`). The hub
logs one warning, ignores them (they are not listed, probed or editable, and their names stay taken), and writes them back unchanged
on every save, so nothing in the file is lost.

## Versions and migration

`version` must be `3`. On start the hub migrates older files (v1 bare list, v2) in place: missing `kind` becomes `hermes`; a Hermes entry without a mode becomes `direct`; entries of other kinds are copied as they are. Before writing, it saves `config.json.v<old>.bak` (never overwritten).

## What the API shows instead

Write-only fields are replaced by booleans: `hasHost`, `hasDashboardPass`, `hasApiServerKey`, `hasDashboardUrl`, … See [Secrets and privacy](/security/secrets).
