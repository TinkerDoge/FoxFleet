# Release process

Foxfleet is alpha and there is no automated release pipeline yet. This is the manual process the maintainers follow, so that a future workflow can automate it.

1. **Green main.** Hub tests, web tests/build, Android unit tests and gitleaks pass (`.github/workflows`).
2. **Bump versions:** `android/app/build.gradle.kts` (`versionCode` +1, `versionName`), root, `web/`, `site/` and `server/` `package.json` versions, `contract/openapi.json` (`info.version`), `docs/roadmap.html` (`version`, `updated`, a `timeline` entry), `CHANGELOG.md` and the release notes.
3. **Regenerate** tokens and `NOTICE.md` (`node design/tools/gen-notice.mjs`) and commit any change.
4. **Dry-run the deploy** on a real host: `deploy/deploy.sh --dry-run`.
5. **Build the artifacts:** the web app (`cd web && npm ci && npm run build`), the server tarball (see `.github/workflows/release.yml` for the exact file list and `SHA256SUMS`) and the release-signed APK (see [Development: signing a release](./development#signing-a-release)). Verify the APK with `apksigner verify --print-certs`.
6. **Tag** `vX.Y.Z-alpha` and push the tag. The draft release workflow builds the tarball (and a signed APK if the signing secrets are set) and creates a GitHub Release; or create the release by hand and attach the files and `SHA256SUMS`.
7. **Docs** deploy automatically from `main` if the Pages workflow is enabled.

Not in place yet: a published Docker image (GHCR), store listings, device tests. See the [roadmap](./roadmap).
