# Commands

Type `/` or `#` as the **first word** of a message to open autocomplete. Use ↑ ↓ and `Enter`/`Tab` (or tap) to pick; `Esc` closes.

## `/` commands

| Command | Effect |
| --- | --- |
| `/new` | Start a new conversation (handled by the app). |
| `/sessions` | Open recent sessions (handled by the app). |
| `/stop` | Stop the current reply (handled by the app). |
| `/btw …` | Side question without interrupting. |
| `/bg …` | Run a prompt in a background session. |
| `/usage` | Token usage for this session. |
| `/reasoning …` | Change reasoning effort or show/hide it. |
| `/title …` | Name the session. |
| `/rollback` | List or restore file checkpoints. |
| `/help` | List the agent's own commands. |
| `/<skill>` | Run a skill by name. |

Only **Hermes** agents get the full list; other kinds get just `/new`, `/sessions` and `/stop`.

## `#skill`

`#` offers the agent's skills (names that start with, or contain, what you typed). Picking one inserts `#skill ` in the message. Skills come from `GET /api/agents/{name}/skills`; owners can enable or disable them (`POST …/skills/{id}/toggle`).
