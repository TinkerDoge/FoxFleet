# Hub API: error codes and agent staleness (0.3.13-alpha)

This page is for client UI work. The machine-readable source is `contract/openapi.json`, in the `Error` and `Agent` schemas.

## Error body

Every hub error looks like this:

```json
{ "error": "The agent is offline", "code": "agent_offline" }
```

- `error`: a short message you can show to the user. Use it when you don't know the `code`.
- `code`: optional. Branch on it, never on the text of `error`.

## History: `GET /api/agents/{name}/sessions/{id}/messages`

The hub asks the agent's dashboard and its API server at the same time and uses the first good answer. If both fail, it replies with the most useful reason, ranked in this order:

| status | `code`           | meaning                                                                                       | suggested UI                                          |
|--------|------------------|-----------------------------------------------------------------------------------------------|-------------------------------------------------------|
| 502    | `agent_offline`  | The agent's machine or ports are unreachable, e.g. the connector isn't running or the machine is asleep | "Agent offline", plus Retry                           |
| 502 or 403 | `auth_failed` | The **agent** rejected the **hub's** credentials (profile or key mismatch on the agent's machine). It's never about the user's own login or permissions, even when the status is 403 (the agent's 403 is passed through). | "Agent needs reconnecting", pointing to Machines/doctor; don't show "you don't have permission" |
| 504    | `timeout`        | The agent didn't answer within the hub's timeout (5 s per attempt)                            | "Agent is slow", plus Retry                           |
| 502    | `upstream_error` | The agent answered with an error or something it couldn't read                                | "Couldn't load this chat", plus Retry                 |

Notes:
- Fallback cap: when the dashboard fails or is slow and the API server answers instead, an **unpaged** history request returns at most the newest **500** messages (the Hermes API server's own cap); the dashboard may return more. Paged requests (`limit`/`offset`, which the web and Android apps use, 80 per page) are unaffected.
- A history failure is never a 401. Only a 401 means the user's own login expired.
- The hub logs every failure as one line, e.g. `{"event":"history.failed","agent":…,"attempts":[{"via":"dashboard","code":…,"status":…},{"via":"api",…}]}`. Secrets are not included.
- Other routes that call the agent can return the same codes, depending on which way the request failed (`agent_offline`, `timeout`, `auth_failed`, `upstream_error`).

## Agent list: `GET /api/agents` → `stale`, `checked_at`

Each agent has two fields that say how fresh its status is:

- `checked_at` (Unix ms): when the status fields (`online`, `chatReady`, `managementReady`, `checks`, …) were probed.
- `stale` (bool):
  - `false`: the status is fresh. It comes from a probe that finished during this request, or from a cached result less than ~10 s old.
  - `true`: the agent's probe didn't finish within ~1.5 s, so the hub sent the last known result instead. That probe is still running, and a later poll will get its result.

How the hub probes:
- Results are cached for about 10 s.
- One probe per agent is shared by everyone who asks at the same time.
- A probe gives up after about 2.5 s; the agent then shows as not ready.
- The very first probe of an agent always runs to the end, because there is no older result to fall back on.

Suggested UI: when `stale` is true, show the status dimmed with "checking…" or "as of <checked_at>". Don't show it as an error.

## Polling (0.3.13)

- **Web:** the agent list refreshes every 12 s only while the tab is visible, and immediately when it becomes visible again. The Machines page refreshes every 30 s (previously 8 s). Pairing checks every 2 s only while a pairing code is shown.
- **Android:** the fleet list refreshes every 12 s and the reaction sync every 30 s, only while the app is in the foreground (lifecycle RESUMED).
