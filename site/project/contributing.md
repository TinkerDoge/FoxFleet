# Contributing

Thanks for helping. Small, focused pull requests are easiest to review. The canonical rules are in [`CONTRIBUTING.md`](https://github.com/TinkerDoge/FoxFleet/blob/main/CONTRIBUTING.md); in short:

1. **Hub (`server/`)**: Node 22+, **no runtime dependencies** on purpose; use the standard library. Add a test under `server/test/` (`npm test`). Keep the privacy contract: no host, IP, URL or secret may appear in any API response (`server/test/v05.test.js` scans for leaks).
2. **Web (`web/`)**: Preact + TypeScript. All user-visible text goes through `t()` (`src/i18n/en.json`). Add a vitest test for logic and API behaviour. `npm run build` must pass (it type-checks).
3. **Android (`android/`)**: `./gradlew testDebugUnitTest assembleDebug`. Screenshot tests live in `app/src/test/.../screenshots`.
4. **Design**: change `design/tokens.json`, run `node design/tools/gen-tokens.mjs`, and commit the generated files (CI fails on stale output).
5. **API changes**: update `contract/openapi.json` and make `contract/run.mjs` cover the operation.
6. **Docs**: this site lives in `site/`. Pages under `reference/api`, `reference/errors`, `hosting/environment` and `project/roadmap` are **generated**; edit the code or `docs/roadmap.html`, not the page.
7. **Never commit** real hostnames, IP addresses, tokens or keys. Use `example.com`, `192.0.2.x` and obvious placeholders. CI runs gitleaks.

By contributing you agree your work is released under the MIT licence. Security issues: [report privately](/security/reporting).
