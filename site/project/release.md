# Release process

Foxfleet is alpha and there is no automated release pipeline yet. This is the manual process the maintainers follow, so that a future workflow can automate it.

1. **Green main.** Hub tests, web tests/build, Android unit tests and gitleaks pass (`.github/workflows`).
2. **Bump versions:** `android/app/build.gradle.kts` (`versionCode` +1, `versionName`), root, `web/`, `site/` and `server/` `package.json` versions, `contract/openapi.json` (`info.version`), `docs/roadmap.html` (`version`, `updated`, a `timeline` entry), `CHANGELOG.md` and the release notes.
3. **Regenerate** tokens and `NOTICE.md` (`node design/tools/gen-notice.mjs`) and commit any change.
4. **Dry-run the deploy** on a real host: `deploy/deploy.sh --dry-run`.
5. **Build the artifacts:** the web app (`cd web && npm ci && npm run build`), the server tarball (see `.github/workflows/release.yml` for the exact file list and `SHA256SUMS`) and the release-signed APK (see [Development: signing a release](./development#signing-a-release)). Verify the APK with `apksigner verify --print-certs`.
6. **Publish: choose ONE way.**
   - **By tag (CI builds everything).** Add `RELEASE_NOTES_X.Y.Z-alpha.md` to the repository, make sure the four signing secrets exist (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`), then tag `vX.Y.Z-alpha` and push the tag. The workflow tests, builds the tarball and the signed APK, writes `SHA256SUMS` for exactly the files it attaches and creates a pre-release (any tag with a hyphen is a pre-release). Without the secrets it attaches only the tarball and its checksums.
   - **By hand.** Build the artifacts yourself, create the GitHub Release in the web UI and upload the files and `SHA256SUMS`. Creating the release creates the tag, which triggers the workflow; that is safe: **the workflow never replaces assets it did not build and never overwrites an existing release.** If a release for the tag already exists it only logs the existing asset names and exits successfully (it never uses `--clobber`). To avoid the run entirely, create the tag only through the release page after publishing, or don't tag from the command line.

   Only people with write access to the repository can push a tag and therefore publish.
7. **Docs** deploy automatically from `main` if the Pages workflow is enabled.

Not in place yet: a published Docker image (GHCR), store listings, device tests. See the [roadmap](./roadmap).
