# DogeDownloader verification

Verified on 2026-10-14, Asia/Bangkok. The amber design was approved on 2026-10-13.

## Deliverable

- File: `releases/DogeDownloader-1.0.apk`
- Display name: DogeDownloader
- Package: `vn.mint.taivideo`
- Version: 1.0, versionCode 1
- Minimum Android API: 26; target and compile API: 34
- Release native ABI: arm64-v8a
- Size: 68,107,648 bytes
- APK SHA-256: `8e7569542033b3381cf87b181fe89ccddf1be4d5484b401f17337061a61e8bfb`

## Build and signing

The initial imported project built successfully before implementation. Its missing SDK 34 components were installed by Gradle. The final `build.ps1` run completed release compilation, Android lint, packaging, apksigner verification, and creation of the named APK and checksum sidecar.

Android lint: **0 errors, 12 warnings**. Warnings concern the inherited API target, dependency update availability, ChromeOS ABI support, resource cleanup, and app-bundle locale handling. The delivered standalone APK contains Vietnamese resources and does not use language splits. The pinned dependencies and original Android compatibility target were retained.

The release APK verifies with APK Signature Scheme v2. Its signer certificate SHA-256 equals the certificate exported from FoxFleet's original local keystore:

`df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df`

The signing properties and keystore remain outside tracked files. No signing passwords were copied into the side project or printed. A release build fails when any required signing value is unavailable.

## Runtime evidence

Reviewed the same code in a temporary, read-only Android 15 x86_64 emulator at phone dimensions. The installable release APK remains arm64; the emulator build uses the documented `-PdogeAbis=x86_64` override.

- Fresh launch: engine and FFmpeg initialize successfully.
- Presentation: the initial revision was reviewed in both modes; the final user-selected revision is dark-only, with readable Vietnamese heading, URL card, actions, history, and status.
- Video screen: compact quality options use the approved amber selection color.
- Shared-link entry: the most recent link is handled, including when another lookup is pending.
- Invalid `https:///` link: the UI shows the Vietnamese validation message.
- Public MP4 sample lookup and download: successful, 788,493-byte video saved to private history and `Download/DogeDownloader`.
- MP3 conversion from the same sample: successful, 147,308-byte audio file saved to private history and the public folder. The direct-video format fallback was reproduced failing before correction and confirmed successful afterward.
- Reinstalling the emulator test APK preserved the existing history entry.
- No AndroidRuntime crash appeared during these checks.
- The original English resource override was removed. The application's 55 default strings are Vietnamese, apart from the requested brand and external identifiers. The activity uses Vietnamese resources even when Android's system language differs.

The public sample was `https://www.w3schools.com/html/mov_bbb.mp4`. The downloader library's Vimeo sample required account credentials; that failure appeared as a Vietnamese app message. YouTube, Facebook, Instagram, and authenticated/private videos were not accepted by this sample test.

Evidence files and build logs are under the feature worktree's ignored `sideProjects/build/verification` directory. User-facing screenshots are copied to the delivered `sideProjects/releases` folder.

## Dark-only pixel-art revision

The user selected pixel-art Shiba styling on 2026-10-14. The final build uses the dark amber theme unconditionally, with dark native window resources and light system-bar icons. A fresh Android 15 emulator review with Android's night mode set to `no` confirmed the app still renders dark. Reinstalling this revision retained both sample download entries. No AndroidRuntime crash appeared.

Two transparent PNG assets were created with the built-in imagegen tool and copied into the workspace and Android resources: a 1254 × 1254 launcher image and a 1536 × 1024 six-cell sprite sheet. Real PNG alpha and per-frame bounds were checked before integration. The app aligns frames at bottom-center and uses nearest-neighbor sampling. Sprite blinking is lifecycle-bound; active download sprites bob and native refresh/download glyphs animate during their operations.

The reusable ZIP contains 32 files: two PNGs, 13 SVG glyphs, 13 Android vector equivalents, README, full prompts, manifest, and checksums. The ZIP was opened and its expected entries inspected. The signed APK's certificate was compared again with the original FoxFleet keystore certificate and matched. This presentation revision leaves the verified video/MP3 engine and history paths unchanged.

An eight-second native emulator recording of the final idle blinking is included as `releases/DogeDownloader-motion.mp4`, alongside the fresh dark-only screenshot.

## Remaining acceptance

Real arm64 phone testing remains pending. Emulator evidence does not establish Android 16 device compatibility, every website's current extractor behavior, background download behavior under device power management, or human usability acceptance. System permission dialogs, keyboard, and file chooser UI follow Android's language.

The original side-project source was checked against saved hashes before copying the revision back. Its pre-change source is preserved in the original workspace's ignored `sideProjects/build/verification/original-source` directory. Work remains on the local `codex/doge-downloader` feature branch; FoxFleet's existing application source and signing material were not changed.
