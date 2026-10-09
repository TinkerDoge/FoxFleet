# Release process

Foxfleet is alpha and there is no automated release pipeline yet. This is the manual process the maintainers follow, so that a future workflow can automate it.

1. **Green main.** Hub tests, web tests/build, Android unit tests and gitleaks pass (`.github/workflows`).
2. **Bump versions:** `android/app/build.gradle.kts` (`versionCode` +1, `versionName`), root and `web/` and `server/` `package.json` versions, `docs/roadmap.html` (`version`, `updated`, a `timeline` entry), `site/project/changelog.md`.
3. **Regenerate** tokens and `NOTICE.md` (`node design/tools/gen-notice.mjs`) and commit any change.
4. **Dry-run the deploy** on a real host: `deploy/deploy.sh --dry-run`.
5. **Tag** `vX.Y.Z-alpha` and push the tag.
6. **Build the APK** (`./gradlew assembleDebug`; debug-signed until a release keystore exists), attach it to a GitHub Release with its SHA-256, and paste the changelog section.
7. **Docs** deploy automatically from `main` if the Pages workflow is enabled.

Not in place yet: signed releases, a published Docker image (GHCR), store listings. See the [roadmap](./roadmap).
