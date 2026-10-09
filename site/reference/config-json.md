# config.json (v3)

One file per user: the owner's is `FOXFLEET_CONFIG`, others live in `users/<id>/config.json` ([layout](/hosting/data)). Mode `0600`, atomic writes, at most 1 MiB and 32 agents.

```json
{
  "version": 3,
  "machines": [
    { "name": "home-hermes", "kind": "hermes", "connection": "connector", "profile": "default",
      "label": "Home", "description": "", "avatar": "🦊",
      "machineId": "<32 hex>",
      "dashboardUser": "admin", "dashboardPass": "…", "apiServerKey": "…" },
    { "name": "router", "kind": "openrouter", "model": "openai/gpt-4o-mini",
      "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "…" },
    { "name": "zai", "kind": "zai", "endpoint": "general", "baseUrl": "https://api.z.ai/api/paas/v4", "model": "glm-5.1", "apiKey": "…" },
    { "name": "inbox", "kind": "mcp-inbox", "inboxTokenHash": "<64 hex sha-256>" }
  ]
}
```

The array order is the display order. You normally never edit this file by hand; use the apps.

## Common fields

| Field | Type | Rules |
| --- | --- | --- |
| `name` | string | `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`, unique, immutable |
| `kind` | string | `hermes`, `openai`, `openrouter`, `zai`, `opencode`, `grok`, `mcp-inbox` (missing = `hermes`) |
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

## Provider kinds (`openai`, `openrouter`, `zai`, `opencode`, `grok`)

| Field | Rules |
| --- | --- |
| `baseUrl` | http(s) origin plus optional path, no credentials/query/fragment; defaults from `PRESETS`. For `zai` it is derived from `endpoint` (`general` or `coding`). |
| `model` | required (preset default), ≤ 200 chars |
| `apiKey` | ≤ 4096 chars; required for every kind except `openai` |

## `mcp-inbox`

`inboxTokenHash`: 64 hex (SHA-256 of the bearer token).

## Versions and migration

`version` must be `3`. On start the hub migrates older files (v1 bare list, v2) in place: missing `kind` becomes `hermes`; a Hermes entry without a mode becomes `direct`; an `openai` entry whose base URL is `openrouter.ai`, `api.z.ai`, `api.x.ai` or `opencode.ai` becomes that kind. Before writing, it saves `config.json.v<old>.bak` (never overwritten).

## What the API shows instead

Write-only fields are replaced by booleans: `hasHost`, `hasApiKey`, `hasBaseUrl`, `hasConnectorToken`, `hasInboxToken`, … See [Secrets and privacy](/security/secrets).
