# Agent awareness: telling Hermes it is in FoxFleet

Hermes describes the chat surface to the model (terminal, Telegram, desktop app...). A FoxFleet chat used to look like Hermes' terminal UI, whose built-in text says "MEDIA: tags are NOT intercepted", so agents did not send pictures and wrote terminal-style answers.

## What the connector does
1. **`source: "foxfleet"`** on every `session.create` and `session.resume`. Hermes uses it as the platform name of the chat. Tools are not affected. A Hermes that rejects the parameter is detected (once) and called without it.
2. **A note** (see `contract/agent-note.golden.txt`) generated from this machine's settings: shared media folders (`<profile>/cache`, `<profile>/workspace`, the temp folder and your `allow-media` folders, never "what exists right now" so the text stays stable), the size limit, the upload folder, and the slash commands that work remotely. Its version is the 8-character hash in `(foxfleet-note vXXXXXXXX)`.
3. **Where the note lives** (Hermes caches the system prompt, so a stable place matters):
   - *Recommended:* `platform_hints.foxfleet.replace` in the profile's `config.yaml`. Hermes puts it in the cached prefix. Written by `node foxfleet-connector.mjs doctor --fix` or `agent-note install` after you confirm.
   - *Fallback:* the note is added in front of the first message of each new chat (`<foxfleet-note>...</foxfleet-note>`; the hub removes it from the transcript). Used when you declined, the profile has its own `platform_hints.foxfleet`, or Hermes is too old.

## Commands
```
node foxfleet-connector.mjs agent-note status     # per profile: installed / stale / missing / user-owned / unsupported / disabled
node foxfleet-connector.mjs agent-note show       # print the note
node foxfleet-connector.mjs agent-note install    # asks first; --yes to skip the question
node foxfleet-connector.mjs agent-note remove     # removes our block and sets agentNote: false
node foxfleet-connector.mjs doctor --fix          # same as install, plus the other checks
```
`agentNote` in `connector.json`: `true` = you agreed (the connector keeps the block current after upgrades), `"message"` = you declined the file write (fallback only), `false` = nothing is written and nothing is sent. Unset = fallback only until you decide.

## Safety
Only the block between `# foxfleet-agent-note:begin` and `# foxfleet-agent-note:end` is ever changed or removed; your own `platform_hints.foxfleet` is never overwritten. The file is replaced atomically and keeps its permissions. The first change makes `config.yaml.foxfleet.bak`.

## Existing chats
Hermes stores each chat's system prompt, so a chat started before the note keeps its old text. When it is resumed with `source: "foxfleet"` Hermes adds its own one-time "surface changed" note; the first compression (or a new chat) picks up the full note.

## Testing
`server/test/agent-note.test.js`: golden text, YAML round trip through PyYAML, params, fallback, and (with `HERMES_REAL_GATEWAY_TEST` + `FAKE_LLM_PORT`) a real Hermes gateway whose fake model records its system prompt: note present, no "terminal UI (TUI)", identical bytes on the next turn and after resume.
