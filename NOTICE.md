# Third-party notices

Foxfleet is MIT licensed. It bundles or builds against:

| Component | Licence | Where |
| --- | --- | --- |
| noVNC | MPL-2.0 (file-level copyleft; unmodified files keep their headers) | `android/app/src/main/assets/novnc/` |
| Preact | MIT | `web/` |
| Vite, Vitest, TypeScript | MIT / MIT / Apache-2.0 | `web/` (build time only) |
| Jetpack Compose, AndroidX, Media3, Coil | Apache-2.0 | `android/` |
| OkHttp | Apache-2.0 | `android/` |
| multiplatform-markdown-renderer | Apache-2.0 | `android/` |
| Telephoto | Apache-2.0 | `android/` |
| Rive runtime | MIT | `android/` |
| Google code scanner (ML Kit, Play services) | Google APIs / ML Kit terms; not redistributed in this repo, fetched by Play services at runtime | `android/` (dependency only) |
| Nunito (wordmark) | SIL OFL 1.1 | `design/brand/` (rendered text only) |

The hub server itself has **no** runtime dependencies (Node standard library only).

## Brand images

The wooden fox artwork in `design/brand/` and the Android drawables was **generated with AI image tools** (ChatGPT image generation for the first concept, Grok Imagine for the final variation) and post-processed locally. It is published under the same MIT licence as the code. See `design/brand/README.md`.
