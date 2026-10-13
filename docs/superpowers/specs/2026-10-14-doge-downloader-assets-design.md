# DogeDownloader dark-only pixel-art assets

The user requested an icon/sprite pack, dark themes only, and animated icons. On 2026-10-14 the user selected the pixel-art Shiba approach.

Keep the approved warm amber palette and clean Vietnamese UI. Make the application dark regardless of the device theme, including its window and launcher background. Generate a transparent pixel-art Shiba launcher mark and a matching six-cell sprite sheet: idle, half blink, full blink, downloading, success, and error. Keep the character consistent and the frames aligned on a three-column, two-row grid.

Use the launcher artwork in the Android icon and the matching character sprites in the header. Use the sprite in the empty state and active download card. Animate idle blinking, downloading bob motion, and the download glyph. Keep animations tied to visible/active UI lifecycle. Export the generated PNGs, a set of matching editable UI glyphs, and asset metadata/prompts as a reusable ZIP pack. All app labels and animation accessibility descriptions remain Vietnamese.

Rebuild the release APK with FoxFleet's unchanged local signing key. Verify lint, resources, certificate identity, dark rendering while the system is set to light, and fresh emulator output. Preserve the already verified video/MP3 download pipeline and private history paths.
