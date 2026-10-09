# Secrets and privacy

## The write-only rule

`WRITE_ONLY` in `server/config.js` lists every sensitive field: `host`, ports, URLs, `baseUrl`, `apiKey`, `dashboardPass`, `apiServerKey`, `dashboardWsToken`, machine ids, inbox token hashes, `uploadDir`. The API:

- accepts them on create and edit;
- never returns them: you get booleans (`hasApiKey`, `hasHost`, `hasConnectorToken`, …);
- keeps the saved value when an edit sends blank;
- scrubs them from upstream responses and error text (`redact()` removes known secrets, `Bearer …`, `password=…`, `sk-…`, `ghp_…` patterns).

This is the **privacy contract**: no client, screenshot or log of a client shows an agent's host, IP or key. The test suite scans responses for leaks.

## At rest

`config.json` (per user) and `accounts/*.json` are written atomically with mode `0600`. API keys are stored **in clear** in `config.json` because the hub must use them. Protect the data directory like a password manager: disk encryption, restrictive permissions, encrypted backups.

## In transit

Hub ↔ clients: https (your proxy or tunnel). Hub ↔ providers: https presets (an OpenAI-compatible base URL may be http on a LAN). Hub ↔ connector: `wss`.

## What is logged

Start-up lines and the first-run setup code. Request bodies and secrets are not logged by the hub.
