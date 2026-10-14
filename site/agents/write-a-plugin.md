# Write your own plugin

::: info FoxFleet is Hermes-only today
The hub runs one agent kind, `hermes`. The API-key chat kinds (OpenAI-compatible, OpenRouter, Z.ai, OpenCode, Grok) and the MCP inbox
were removed. Every agent still carries a `kind`, and the apps draw their forms from the hub's schema, so a kind can be added again
without client changes. The plan is for other agents to come back as thin clients of a hub **bot API** (any language) rather than as
provider code inside the hub; see `design/notes/native-hermes-platform.md`.
:::

## Anatomy of a kind

A kind is listed in `KINDS` and described by an entry in `KIND_SPECS` (`server/config.js`):

| Part | Purpose |
| --- | --- |
| `label`, `summary` | Shown in the *Add agent* picker. |
| `auth` | List of auth methods: `api_key`, `none` (derived from fields if omitted). |
| `warnings` | Strings shown above the form. |
| `planned` | Listed in the picker but cannot be created yet. |
| `capabilities` | `chat`, `images`, `files`, `screen`, `voice`, `skills`, `sessions` booleans that decide which controls the apps show. |
| `fields` | The config schema: `key`, `label`, `type` (`text`, `multiline`, `id`, `host`, `port`, `url`, `secret`, `enum`), `required`, `default`, `secret` (write-only), `private` (write-only, not a credential), `advanced`, `help`, `max`, `options`, `when` (show only if another field equals a value). |

Fields marked `secret` or `private` are in `WRITE_ONLY`: never returned, kept on blank edit, replaced by `has<Field>` booleans in the API. Validation lives in `connection()`.

A kind also needs a runtime in `server/index.js`: how the hub probes it (`probeAny()`) and how a chat turn starts (`launcher()`).
Saved agents of a kind the running hub does not know are ignored with a warning and kept in `config.json` unchanged, so a hub
downgrade never loses them.

## The event stream

`POST /api/agents/{name}/chat` answers with **Server-Sent Events** in the OpenAI chat-completions style:

```text
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}

data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}

data: [DONE]
```

Clients also understand `delta.reasoning_content` (shown as a collapsible reasoning block) and Hermes-style tool/status events.

## Local agents through a machine

The machine connector is the intended carrier for **other local agents** too (a CLI agent, a local model server), so they need no open port either. Today only Hermes profiles are discovered. The extension point is small:

- **Connector side** (`connector/foxfleet-connector.mjs`): `discoverProfiles()` returns `{ profile, home }` entries and `profileTargets()` turns one into local `api` / `dashboard` targets with their credentials. A `generic` provider would add its own discovery (a folder of manifests, a config file) returning entries with a `kind` and a local base URL, and send them in the same `profiles` frame.
- **Hub side** (`syncProfiles()` in `server/index.js`): creates the agents with `connection: 'machine'` and a `machineId`; `base()` in `server/hermes.js` resolves them to the loopback forwarder. A new kind would add its own client that calls `tunnelPorts.get(`${machineId}:${name}`)` the same way.

Nothing here is wired for non-Hermes kinds yet; the frame and storage shapes are already per-agent so it needs no protocol change.

## What the config schema may not do

- Kind and connection mode cannot change after creation.
- Endpoints must be validated on the hub (`connection()` accepts only HTTPS origins without credentials, paths, queries or fragments).
- New env vars must be added to `site/.vitepress/gen.mjs` or the docs build fails.
