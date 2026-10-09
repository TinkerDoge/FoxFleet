# Agents, kinds and capabilities

An **agent** is one saved connection on your hub: a name, a *kind* and the settings that kind needs. Each user has up to 32 agents.

## Kinds (plugins)

A **kind** (the plugin id) is declared in `server/config.js` (`KIND_SPECS`). It lists the fields, auth methods, warnings and capabilities. Clients draw the *Add agent* form from `GET /api/agent-kinds`, so adding a kind needs no client change.

| Kind | Auth | How the hub reaches it | Capabilities |
| --- | --- | --- | --- |
| `hermes` | connector token, or direct dashboard login | Connector (default, the agent dials out) or direct host/ports (advanced) | chat, sessions, files, skills, screen, voice, images |
| `openai` | optional API key | Hub calls `{baseUrl}/chat/completions` | chat, images |
| `openrouter` | API key | `https://openrouter.ai/api/v1` | chat, images |
| `zai` | API key | `general` or `coding` endpoint (see the [warning](/agents/zai)) | chat |
| `opencode` | API key | OpenCode Zen (`https://opencode.ai/zen/v1`) or your own base URL | chat, images |
| `grok` | API key | `https://api.x.ai/v1` | chat, images |
| `mcp-inbox` | bearer token (shown once) | The outside agent calls the hub's `/mcp` | chat, sessions, mailbox |
| `a2a`, `webhook` | | *Listed as planned; cannot be created yet* | |

Provider endpoints are presets that live on the hub; no client receives them.

## Capabilities

Every agent view carries a `capabilities` object that tells clients what to show:
`chat`, `images`, `files`, `screen`, `voice`, `skills`, `sessions`, `mailbox`. The apps hide controls an agent cannot use (no attach button without `files`, no screen button without `screen`, and so on).

## Writing and editing

- Fields marked `writeOnly` (API keys, hosts, URLs, passwords, tokens) are never returned. When editing, leave them blank to keep the saved value; the form shows "saved on the hub".
- The kind and the connection mode (connector vs direct) cannot change after creation: delete and re-add.
- **Test connection** probes a draft without saving it (`POST /api/connections/test`).
- Order is a single list: `POST /api/connections/order` must list every agent exactly once.

Related: [Onboarding agents](/agents/), [config.json schema](/reference/config-json).
