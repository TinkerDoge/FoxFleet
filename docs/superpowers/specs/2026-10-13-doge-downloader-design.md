# DogeDownloader UI and signed APK

Approved by the user on 2026-10-13: the recommended amber layout.

## Scope

Revise the Android application imported in `sideProjects` and deliver an installable release APK named DogeDownloader. Preserve the existing application ID (`vn.mint.taivideo`), download qualities, share-link entry, background downloads, history, file opening, sharing, and deletion. Preserve the private history directory so existing downloads remain accessible.

## Interface

Use warm amber accents, an ivory background, dark readable text, rounded cards, consistent spacing, and a matching dark theme. Put the brand and update action in the header. The primary card contains the Vietnamese heading, URL field, clipboard action, and video lookup button. Show video details and compact quality choices together. Show current download progress independently of the selected video. Download history has a useful empty state and compact accessible actions.

App-authored text, accessibility labels, notifications, dialogs, validation, and failure messages are Vietnamese on every device language. DogeDownloader is the requested brand exception; external video titles and uploader names retain their original text. Do not expose English engine exceptions to users. System-owned permission prompts and file choosers follow Android's language.

## Packaging and signing

Reuse FoxFleet's ignored signing properties and original keystore, without copying credentials into the project or logging passwords. A release build must fail when signing credentials are unavailable. Keep generated outputs, caches, and local configuration ignored. Supply a repeatable Windows build command, verify the APK with apksigner, and compare its certificate with the keystore's certificate. Use the existing arm64 device target.

## Verification

Run the Kotlin compilation, Android lint, release packaging, APK metadata inspection, Vietnamese resource inspection, and certificate comparison. Use an emulator for visual review when available. Build and signature checks do not establish successful real-device downloads or user acceptance.
