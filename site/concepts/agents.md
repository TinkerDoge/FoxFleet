# Agents, kinds and capabilities

An **agent** is one saved connection on your hub: a name, a *kind* and the settings that kind needs. Each user has up to 32 agents.

## Kinds

FoxFleet is Hermes-only: `hermes` is the one kind. Agents keep the `kind` field so other kinds can return later (as bot-API clients). A kind is declared in `server/config.js` (`KINDS`, `KIND_SPECS`). It lists the fields, auth methods, warnings and capabilities. Clients draw the *Add agent* form from `GET /api/agent-kinds`, so adding a kind needs no client change.

| Kind | Auth | How the hub reaches it | Capabilities |
| --- | --- | --- | --- |
| `hermes` | machine token (paired once per computer), or direct dashboard login | Machine connector (default, the computer dials out; credentials stay on it) or direct host/ports (advanced) | chat, sessions, files, skills, screen, voice, images |

Saved agents of other kinds (the removed OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok and MCP-inbox kinds) are ignored with one warning in the log and kept in `config.json` unchanged.

## Capabilities

Every agent view carries a `capabilities` object that tells clients what to show:
`chat`, `images`, `files`, `screen`, `voice`, `skills`, `sessions`. The apps hide controls an agent cannot use (no attach button without `files`, no screen button without `screen`, and so on).

## Writing and editing

- Fields marked `writeOnly` (keys, hosts, URLs, passwords, tokens) are never returned. When editing, leave them blank to keep the saved value; the form shows "saved on the hub".
- The kind and the connection mode (connector vs direct) cannot change after creation: delete and re-add.
- **Test connection** probes a draft without saving it (`POST /api/connections/test`).
- Order is a single list: `POST /api/connections/order` must list every agent exactly once.

Related: [Onboarding agents](/agents/), [config.json schema](/reference/config-json).
