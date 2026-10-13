# DogeDownloader Implementation Plan

> **For agentic workers:** Use executing-plans to implement this approved plan in the isolated feature worktree.

**Goal:** Deliver DogeDownloader with a clean Vietnamese interface and a release APK signed with FoxFleet's key.

**Architecture:** Keep the existing Compose activity, view model, download service, engine, and history store. Limit changes to presentation, localized messages, user-facing brand, build portability, and signing. Preserve package identity and private file paths.

**Tech Stack:** Kotlin, Jetpack Compose Material 3, youtubedl-android, Android Gradle Plugin, Gradle, JDK 17.

## Task 1: Establish build and identity

- [x] Copy the untracked side project into `codex/doge-downloader` and record original source hashes.
- [x] Attempt a baseline debug build and identify missing SDK or dependency requirements.
- [x] Add the existing verified Gradle wrapper to `sideProjects`; retain SDK 34 and minimum API 26. The baseline build installed the missing SDK 34 components.
- [x] Read ignored FoxFleet signing properties in Gradle; fail release packaging when credentials are missing.
- [x] Set project and launcher name to DogeDownloader, update the launcher artwork, and ignore local caches and signing properties.

## Task 2: Revise presentation and Vietnamese copy

- [x] Replace `MainActivity.kt` presentation with a responsive scrolling layout, amber header, URL card, clipboard action, lookup button, video card, compact quality selector, independent progress card, and history cards.
- [x] Update `ui/Theme.kt`, `res/values/colors.xml`, and `res/values/themes.xml` for coordinated light/dark colors and typography.
- [x] Remove the English resource override. Put all app messages and content descriptions in Vietnamese resources.
- [x] Replace raw view-model and service exceptions with Vietnamese messages. Preserve internal diagnostics through Android logs.
- [x] Change new public download folder naming to `Download/DogeDownloader`; keep private history paths compatible.

## Task 3: Verify and package

- [x] Run `gradlew.bat :app:assembleRelease :app:lintRelease` with JDK 17 and the installed Android SDK.
- [x] Inspect packaged application ID, version, label, resources, native ABI, and signature.
- [x] Compare the signing certificate SHA-256 with FoxFleet's original keystore certificate.
- [x] Review the fresh UI on an available emulator; record any remaining real-device acceptance boundaries.
- [x] Copy the verified APK to `sideProjects/releases/DogeDownloader-1.0.apk` in the user's original workspace.
- [x] Copy completed source changes back only after confirming original source hashes are unchanged.
- [x] Write concise build instructions and validation evidence; inspect the diff and confirm no signing secrets are tracked.
