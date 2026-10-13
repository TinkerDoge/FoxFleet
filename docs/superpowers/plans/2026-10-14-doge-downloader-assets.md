# DogeDownloader Dark Assets Implementation Plan

> **For agentic workers:** Use executing-plans in the existing isolated feature worktree.

**Goal:** Deliver a dark-only DogeDownloader APK and reusable pixel-art asset pack.

**Architecture:** Preserve the current downloader, signing, and history code. Add generated PNG resources and small Compose animation components. Use native glyph assets for small action icons and preserve the transparent source artwork.

**Tech Stack:** Imagegen, PNG, Kotlin, Compose Canvas and animation, Android vector drawables, SVG, PowerShell ZIP packaging.

- [x] Generate and immediately save a transparent pixel-art launcher mark in the workspace.
- [x] Generate and immediately save a matching three-column/two-row sprite sheet using the launcher as character reference.
- [x] Inspect actual dimensions, transparency, alignment, and pixel-art consistency before app integration.
- [x] Add reusable native UI glyph exports, asset manifest, and full generation prompts.
- [x] Make `ui/Theme.kt` dark-only and update native window/background resources to match.
- [x] Add `ui/PixelArt.kt` for sprite rendering, visible lifecycle-bound blinking, and active download icon motion.
- [x] Integrate artwork into launcher, header, empty history, and download progress while keeping Vietnamese labels.
- [x] Build the signed release APK, run lint, and compare its certificate with FoxFleet's key.
- [x] Review the new APK UI on the test emulator with the system in light mode; verify active animation visually.
- [x] Package the asset ZIP and final APK, update evidence, and copy only changed deliverables back to the original side-project folder.
