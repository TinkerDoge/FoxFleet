# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

1. **Hub (`server/`)**: Node 22+, no runtime dependencies on purpose; use the standard library. Add a test under `server/test/` (`npm test`). Keep the privacy contract: no host, IP, URL or secret may appear in any API response (`server/test/v05.test.js` scans for leaks).
2. **Web (`web/`)**: Preact + TypeScript. All user-visible text goes through `t()` (`src/i18n/en.json`). Add a vitest test for logic and API behaviour. `npm run build` must pass (it type-checks).
3. **Android (`android/`)**: `./gradlew testDebugUnitTest assembleDebug`. Screenshot tests live in `app/src/test/.../screenshots`.
4. **Design**: change `design/tokens.json`, run `node design/tools/gen-tokens.mjs`, and commit the generated files (CI fails on stale output).
5. **Never commit** real hostnames, IP addresses, tokens or keys. Use `example.com`, `192.0.2.x` and obvious placeholders in docs and tests.

By contributing you agree your work is released under the MIT licence.
