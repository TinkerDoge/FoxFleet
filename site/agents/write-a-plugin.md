# Write your own plugin

::: info How plugins work today
Plugins are **built into the hub**, not loaded from disk at runtime. A provider "plugin" is a *kind* declared in `server/config.js` plus (for non-OpenAI-style APIs) a small runtime client. There is no third-party plugin loader yet; contributing a kind means sending a pull request. The apps need **no changes** because forms are drawn from the schema.
:::

## Anatomy of a kind

A kind is an entry in `KIND_SPECS` (`server/config.js`):

| Part | Purpose |
| --- | --- |
| `label`, `summary` | Shown in the *Add agent* picker. |
| `auth` | List of auth methods: `api_key`, `none` (derived from fields if omitted). |
| `warnings` | Strings shown above the form (e.g. the Z.ai coding-plan warning). |
| `capabilities` | `chat`, `images`, `files`, `screen`, `voice`, `skills`, `sessions`, `mailbox` booleans that decide which controls the apps show. |
| `fields` | The config schema: `key`, `label`, `type` (`text`, `multiline`, `id`, `host`, `port`, `url`, `secret`, `enum`), `required`, `default`, `secret` (write-only), `private` (write-only, not a credential), `advanced`, `help`, `max`, `options`, `when` (show only if another field equals a value). |
| runtime | How the hub talks to the agent: probe (status), chat (stream). |

Fields marked `secret` or `private` are in `WRITE_ONLY`: never returned, kept on blank edit, replaced by `has<Field>` booleans in the API. Validation lives in `bridged()` (provider kinds) or `connection()`.

## The event stream

`POST /api/agents/{name}/chat` must answer with **Server-Sent Events** in the OpenAI chat-completions style:

```text
data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}

data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}

data: [DONE]
```

Clients also understand `delta.reasoning_content` (shown as a collapsible reasoning block) and Hermes-style tool/status events. For OpenAI-style providers the hub **pipes the upstream stream through unchanged** (and rejects a non-`text/event-stream` answer as `502 Invalid chat stream`).

## Worked example: a new API-key provider

Suppose "Acme AI" offers an OpenAI-compatible API at `https://api.acme.example/v1`.

1. Add the id and preset in `server/config.js`:

   ```js
   export const CHAT_KINDS = ['openai', 'openrouter', 'zai', 'opencode', 'grok', 'acme'];
   export const PRESETS = {
     // …
     acme: { baseUrl: 'https://api.acme.example/v1', model: 'acme-large' },
   };
   ```

2. Add the spec to `KIND_SPECS`, next to `grok`:

   ```js
   acme: { label: 'Acme AI', summary: 'Acme models with your Acme API key.', auth: ['api_key'],
     capabilities: { chat: true, images: false, files: false, screen: false, voice: false, skills: false, sessions: false, mailbox: false },
     fields: [...COMMON,
       { key: 'model', label: 'Model', type: 'text', required: true, default: PRESETS.acme.model },
       { key: 'apiKey', label: 'Acme API key', type: 'secret', secret: true, required: true }] },
   ```

   Because `acme` is in `CHAT_KINDS`, `bridged()` validates it, `openaiClient()` probes `/models` and streams `/chat/completions`, and the generic chat route handles it. Nothing else to wire.

3. Test: add a case to `server/test/` (see `v1.test.js` for the pattern with a mock upstream), run `npm test` in `server/`, and confirm `GET /api/agent-kinds` lists it. `node --test server/test/*.test.js` also runs the privacy test, which fails if a host or key leaks.
4. Document it under `site/agents/` and add the row in the README's agent matrix.

## A kind with a different protocol

If the provider is **not** OpenAI-compatible, write a client module like `server/openai.js` that exposes `chat(m, messages, signal)` (returns a `fetch` Response whose body is the SSE stream above, adapting upstream frames if needed) and `probe(m)` (returns `{ online, chatReady, checks, capabilities }`), then dispatch to it in `server/index.js` next to the `isChatKind` branches. Keep the privacy contract: never put a URL, host or key in an error message (`fault()` messages are shown to clients).

## What the config schema may not do

- Kind and connection mode cannot change after creation.
- Endpoints must be validated on the hub (`baseUrl()` rejects credentials, queries and fragments).
- New env vars must be added to `site/.vitepress/gen.mjs` or the docs build fails.
