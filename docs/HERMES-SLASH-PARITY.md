# Hermes dashboard slash commands: FoxFleet parity research

Researched 10 October 2026 (Asia/Bangkok). FoxFleet source: `d8ebee2f760e5ba9c92a45fe9c7f4422aaba6762`.
Hermes code inspected at `cf23a1a5cc3e02b2a2d4526b4a1ac66ffaac614b`, fetched from public GitHub.
The dashboard and slash-reference documentation was read live; those documentation URLs can change.

FoxFleet already bundles the same **103 built-in command names** as the inspected Hermes revision.
Its limited experience comes from menu truncation, missing live metadata, and incomplete execution
routing. This research adds documentation only. Evidence consists of source inspection, a Python
AST comparison, and execution of FoxFleet's actual web suggestion function; no connected Hermes
dashboard, production agent, browser, or Android device was exercised in this session.

## Why the dashboard offers more

The official dashboard's Chat tab embeds `hermes --tui` over PTY/WebSocket and renders it with
xterm.js. Its command handling and interactive pickers come from the real TUI. FoxFleet renders
its own chat UI and bridges selected native operations, so each supported command needs an
explicit execution route and result rendering. The dashboard also has separate management pages;
their capabilities should not be inferred from the chat command list alone.
[Source: official dashboard documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard/).

Hermes discovers skills, quick commands, plugins, and bundles dynamically. Menus depend on the
profile and workspace; 103 counts core commands, not every installation's complete menu.
[Source: pinned native command catalog and dispatcher](https://github.com/NousResearch/hermes-agent/blob/cf23a1a5cc3e02b2a2d4526b4a1ac66ffaac614b/tui_gateway/methods_tools.py#L503).

## Confirmed gaps in FoxFleet

### 1. Typing `/` cuts off useful commands

Both composers request **60 suggestions**. Suggestions are sorted by category, aliases become
individual rows, unavailable commands remain in the list, and the combined list is sliced to 60.
The result offers only Session and Configuration categories on bare `/` in the inspected catalog.

Executing the actual web suggestion function against `catalogFor()` for a native Hermes agent
produced 60 rows, **19 unavailable**. Positions below are one-based in the expanded list. A
synthetic skill was supplied to check discoverability; it is not a claim about installed skills.

| Choice | Position | Visible after typing only `/`? |
| --- | ---: | --- |
| `/model` | 64 | No |
| `/help` | 85 | No |
| `/usage` | 90 | No |
| `/memory` | 112 | No |
| `/skills` | 117 | No |
| Example installed-skill name | 131 | No |

Typing a matching prefix still finds these commands. The web and Android command search matches
name prefixes; it does not search descriptions or provide fuzzy matching. Adding a scrollbar
alone would not recover rows already removed by the slice.

Evidence: `web/src/lib/commands.ts:52`, `web/src/chat/Composer.tsx:44`,
`android/app/src/main/java/dev/foxfleet/app/ui/screens/ChatScreen.kt:571`, and
`android/app/src/main/java/dev/foxfleet/app/ui/chat/Commands.kt:88`.
The Android cutoff is source-confirmed; the runtime reproduction used the web function.

### 2. The live catalog is present but does not drive the composer

FoxFleet exposes `GET /api/agents/{agent}/native/commands`, but returns only `pairs`.
The composers instead fetch `/api/agents/{agent}/commands`, which serves the bundled registry.
The connector's `catalog` operation calls `commands.catalog` with empty parameters.

Hermes's pinned catalog returns `pairs`, `sub`, `canon`, `commands`, `categories`, `skills`,
`skill_count`, and `warning`, using session/profile/workspace context. FoxFleet loses the extra
fields and cannot supply session context. Its generator also omits `argument_mode`, `busy_policy`,
and `desktop_subcommands` from the bundled projection.
[Source: pinned catalog handler](https://github.com/NousResearch/hermes-agent/blob/cf23a1a5cc3e02b2a2d4526b4a1ac66ffaac614b/tui_gateway/methods_tools.py#L503),
[source: registry metadata](https://github.com/NousResearch/hermes-agent/blob/cf23a1a5cc3e02b2a2d4526b4a1ac66ffaac614b/hermes_cli/commands.py#L366).

Evidence: `server/index.js:453`, `server/index.js:473`, `connector/foxfleet-connector.mjs:314`,
`web/src/api/client.ts:191`, `android/app/src/main/java/dev/foxfleet/app/HubViewModel.kt:175`,
and `design/tools/gen-hermes-commands.py:25`.

### 3. A menu entry does not establish command execution

The bundle labels 7 definitions `app`, 51 `chat`, and 45 `unavailable`, before hub-control
overrides. `server/commands.js` marks the `chat` entries executable but `verified: false`.

The composers intercept local commands and Queue/Steer/Busy. Other permitted slash text follows
the ordinary chat-send path. For native sessions, `nativeHub.send()` submits or steers that text;
it does not resolve or dispatch commands. Thus typed `/model`, `/usage`, or `/compress` has no
dedicated command execution in that path. A model's interpretation of the text would not prove
the corresponding Hermes control ran.

The connector permits `command.dispatch` only for `compress`, `retry`, `undo`, `memory`, and
`skills`. That low-level allowlist is not connected to a public command-invocation route or the
composer. The existing model picker does use a dedicated session-scoped `config.set` operation,
and the profile busy control has its own explicit route. Those controls are useful foundations.

Evidence: `web/src/chat/Composer.tsx:101`,
`android/app/src/main/java/dev/foxfleet/app/ui/screens/ChatScreen.kt:573`,
`server/hermes-ui.js:115`, `connector/foxfleet-connector.mjs:302`, and `server/index.js:461`.

### 4. Availability needs to be checked per operation and subcommand

Hermes uses session/config methods, `command.dispatch`, and `slash.exec`. Dispatch takes `name`,
`arg`, and `session_id` and handles selected commands. Results can request output rendering,
prefill, or skill/prompt submission.

Desktop `/skills` exposes `pending`, `approve`, `reject`, `diff`, and `approval`; CLI also offers
search/install/browse/inspect/audit. Permissions should apply per operation and subcommand.
[Source: pinned dispatcher](https://github.com/NousResearch/hermes-agent/blob/cf23a1a5cc3e02b2a2d4526b4a1ac66ffaac614b/tui_gateway/methods_tools.py#L1086),
[source: `/skills` surface scope](https://github.com/NousResearch/hermes-agent/blob/cf23a1a5cc3e02b2a2d4526b4a1ac66ffaac614b/hermes_cli/commands.py#L251).

## Command families worth exposing

These are Hermes command examples, not claims of working FoxFleet parity. Syntax and availability
must follow the connected version and the bridge's tested handlers.

| Family | Examples / choices | FoxFleet assessment |
| --- | --- | --- |
| Discover and inspect | `/help`, `/palette`, `/usage`, `/status`, `/context` | High value; help/palette can be local, live statistics need native reads |
| Model and response behavior | `/model`, `/reasoning high`, `/personality` | Existing model picker is a foundation; typed-command routing and reasoning/personality remain incomplete |
| Conversation management | `/new`, `/sessions`, `/title`, `/retry`, `/undo`, `/branch`, `/save` | Local controls exist; native rewind, branching, and export need explicit integration |
| Context | `/compress`, `/compact`, compression preview/focus options | Low-level dispatch exists; composer execution and state refresh are missing |
| Reusable workflows | `/<skill>`, `/plan`, `/learn`, `/init`, `/bundles` | Live discovery and directive handling would add substantial value |
| Long-running work | `/goal status/pause/resume/clear`, `/subgoal`, `/loop`, `/bg`, `/btw`, `/agents` | Needs lifecycle/status rendering as well as invocation |
| Skills and memory review | `/skills pending/diff/approve/reject`, `/memory pending/approve/reject` | Respect operation-specific availability and show real results |
| Host/profile administration | `/tools`, `/cron`, `/reload-mcp`, `/reload-skills`, `/plugins` | Separate management integration and scope checks; current remote availability is incomplete |

[Source: official slash-command reference](https://hermes-agent.nousresearch.com/docs/reference/slash-commands/).

## Recommended order

1. **Make the existing commands discoverable.** Provide the complete searchable list or explicit
   pagination; separate aliases and unavailable entries from useful default choices; make skills
   reachable on bare `/`; add a local command browser/help view. Increasing 60 to another arbitrary
   ceiling would postpone the same problem on installations with more extensions.
2. **Connect the live catalog.** Preserve its metadata, pass the runtime session when present,
   normalize it into one shared web/Android contract, and intersect it with the bridge's actual
   handlers. Keep a clearly identified bundled fallback. Refresh on profile/workspace and skill changes.
3. **Wire a useful initial command set.** Start with `/model`, `/reasoning`, `/personality`,
   `/usage`, `/status`, `/context`, `/compress`, installed-skill invocation, and help/palette.
   Reuse dedicated native methods where available; handle dispatch directives explicitly.
4. **Expand workflow and session controls.** Add planning/learning/goals, then rewind, branch, and
   export as their state changes and busy behavior are verified. Add background-task and
   administration commands with appropriate result views.

Keep FoxFleet's per-conversation send preference distinct from Hermes's profile-wide `/busy`
setting. Preserve existing account/profile ownership, command allowlists, request cards, and
event replay when adding invocation. A connected catalog describes discovery; it does not
automatically grant remote execution authority.

Acceptance for future implementation should include bare `/` discovery on both clients,
profile/workspace-specific skills, real handler execution with observable state/results,
unsupported subcommand explanations, command-specific busy behavior, and reconnect after a
state-changing command. The research reproduced discovery limitations; execution parity still
requires live Hermes integration evidence.

## Verification performed

- Parsed the pinned `COMMAND_REGISTRY` with Python `ast`, without executing upstream code.
  Compared core names with `server/hermes-commands.json`: 103 versus 103, no missing or removed names.
- Loaded `web/src/lib/commands.ts` through Node 24's `stripTypeScriptTypes`, injected the unchanged
  bundled JSON import, and invoked its exported `commandSuggestions()` with the real
  `server/commands.js` catalog projection. Observed the 60-row cutoff and positions above.
- Traced web/Android input to hub catalog and native send operations, and checked the connector
  dispatch allowlist against pinned Hermes source.
- Reviewed the existing `docs/HERMES-CHAT-CONTROLS.md` and
  `design/notes/hermes-ui-gateway.md` as historical research; their earlier runtime observations
  were not re-run here.
