# Third-party notices

Foxfleet is MIT licensed (see `LICENSE`). This file lists what it bundles or builds against. Most of it is **generated** by
`node design/tools/gen-notice.mjs` from `web/package.json` (+ installed packages) and `android/gradle/libs.versions.toml` (+ the Gradle module cache), so re-run it when dependencies change.
The hub server itself has **no** runtime dependencies (Node standard library only).

## Web app (bundled)

| Package | Licence | Where |
| --- | --- | --- |
| dompurify 3.4.16 | (MPL-2.0 OR Apache-2.0) | `web/` (bundled into the web app) |
| marked 18.1.0 | MIT | `web/` (bundled into the web app) |
| preact 10.29.8 | MIT | `web/` (bundled into the web app) |
| noVNC (vendored, unmodified) | MPL-2.0; individual files may carry their own header (core/des.js: BSD-style) | `web/src/vendor/novnc/` (lazy-loaded screen view) and `android/app/src/main/assets/novnc/` |
| pako (inside noVNC) | MIT (+ zlib) | `web/src/vendor/novnc/vendor/pako/`, same under the Android assets; licence text in `vendor/pako/LICENSE` |

MPL-2.0 is file-level copyleft: the noVNC files are unmodified and keep their headers; the full texts ship in `web/src/vendor/novnc/LICENSE.txt`.
DOMPurify is dual-licensed (MPL-2.0 OR Apache-2.0); either applies.

## Web build tooling (not shipped)

| Package | Licence | Where |
| --- | --- | --- |
| @preact/preset-vite 2.10.6 | MIT | `web/` (build/test time only, not shipped) |
| @types/node 20.19.43 | MIT | `web/` (build/test time only, not shipped) |
| jsdom 25.0.1 | MIT | `web/` (build/test time only, not shipped) |
| typescript 5.9.3 | Apache-2.0 | `web/` (build/test time only, not shipped) |
| vite 5.4.21 | MIT | `web/` (build/test time only, not shipped) |
| vitest 2.1.9 | MIT | `web/` (build/test time only, not shipped) |

Vite bundles only the runtime packages above into `web/dist`; none of the build tools end up in it.

## Android app (direct dependencies; transitive AndroidX/Kotlin artefacts are Apache-2.0)

| Library | Licence | Where |
| --- | --- | --- |
| androidx.activity:activity-compose 1.10.1 | The Apache Software License, Version 2.0 | `android/` |
| androidx.compose.animation:animation (BOM) | The Apache Software License, Version 2.0 | `android/` |
| androidx.compose.foundation:foundation (BOM) | The Apache Software License, Version 2.0 | `android/` |
| androidx.compose.material3:material3 (BOM) | The Apache Software License, Version 2.0 | `android/` |
| androidx.compose.material:material-icons-core 1.7.8 | The Apache Software License, Version 2.0 | `android/` |
| androidx.compose.ui:ui (BOM) | The Apache Software License, Version 2.0 | `android/` |
| androidx.compose:compose-bom 2025.12.00 | The Apache Software License, Version 2.0 | `android/` |
| androidx.core:core-ktx 1.16.0 | The Apache Software License, Version 2.0 | `android/` |
| androidx.exifinterface:exifinterface 1.4.1 | The Apache Software License, Version 2.0 | `android/` |
| androidx.lifecycle:lifecycle-runtime-compose 2.9.4 | The Apache Software License, Version 2.0 | `android/` |
| androidx.media3:media3-datasource-okhttp 1.8.0 | The Apache Software License, Version 2.0 | `android/` |
| androidx.media3:media3-exoplayer 1.8.0 | The Apache Software License, Version 2.0 | `android/` |
| androidx.media3:media3-ui 1.8.0 | The Apache Software License, Version 2.0 | `android/` |
| androidx.webkit:webkit 1.14.0 | The Apache Software License, Version 2.0 | `android/` |
| app.rive:rive-android 11.14.0 | MIT License | `android/` |
| com.google.android.gms:play-services-code-scanner 16.1.0 | ML Kit Terms of Service | `android/` |
| com.mikepenz:multiplatform-markdown-renderer-coil3 0.38.1 | Apache-2.0 | `android/` |
| com.mikepenz:multiplatform-markdown-renderer-m3 0.38.1 | Apache-2.0 | `android/` |
| com.squareup.okhttp3:okhttp 4.12.0 | The Apache Software License, Version 2.0 | `android/` |
| io.coil-kt.coil3:coil-compose 3.3.0 | The Apache License, Version 2.0 | `android/` |
| io.coil-kt.coil3:coil-network-okhttp 3.3.0 | The Apache License, Version 2.0 | `android/` |
| me.saket.telephoto:zoomable-image-coil3 0.17.0 | The Apache Software License, Version 2.0 | `android/` |
| org.jetbrains.kotlinx:kotlinx-coroutines-android 1.11.0 | Apache-2.0 | `android/` |
| org.jetbrains.kotlinx:kotlinx-serialization-json 1.7.3 | The Apache Software License, Version 2.0 | `android/` |
| Gradle wrapper (gradle-wrapper.jar, Gradle 8.14.3) | Apache-2.0 | `android/gradle/wrapper/` (committed build tool, not shipped in the APK) |

Notes: the ML Kit / Play services code scanner is **not** redistributed in this repo; Google Play services provides it at runtime under Google's
terms (ML Kit Terms of Service / Android SDK Licence as reported by the artefact POMs).

## Fonts

Nunito (SIL OFL 1.1) is used only to render the wordmark PNGs at design time (`design/tools/make-wordmarks.py`); the font file is not included.

## Brand images (AI-generated)

The wooden fox mascot in `design/brand/` and the Android drawables was **generated with AI image tools** (ChatGPT image generation for the first concept, Grok Imagine for the final variation) and post-processed locally. It is published under the same MIT licence as the code. See `design/brand/README.md`.
