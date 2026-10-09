# Foxfleet API contract

- `openapi.json`: OpenAPI 3.1 description of the hub API (≈ 40 operations). Clients ask for the hub address on first launch, so `servers` is a placeholder.
- `validate.mjs`: a dependency-free validator for the subset of JSON Schema the spec uses.
- `run.mjs`: the shared scenario. It signs in (or performs first-run setup), exercises agents, admin, devices and error paths against **any base URL**, and fails on the first response that is not declared in the spec or does not match its schema.

It runs in two places, so the web mock cannot drift from the real hub:

```
cd server && node --test test/contract.test.js     # real hub
cd web && npx vitest run tests/contract.test.ts    # web/tools/mock-hub.mjs
```

When you add or change an endpoint: edit `openapi.json`, extend `run.mjs` if it can be exercised without a live agent, then make the hub and the mock pass.
Not yet exercised by the scenario (they need a live agent): sessions, chat (SSE), file upload, screen.
