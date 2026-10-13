# DogeDownloader Pixel Shiba Pack

Created for the dark-only Vietnamese DogeDownloader interface. Raster artwork was generated with the built-in imagegen tool; UI glyphs are original native vector assets.

## Contents

- `doge-launcher.png`: transparent pixel-art Shiba head, 1254 × 1254 pixels. Used by Android's adaptive icon with a safe inset.
- `doge-sprites.png`: transparent 1536 × 1024 sprite sheet, three columns and two rows of 512 × 512 cells.
- `icons/svg/`: 13 editable pixel-style UI glyphs, using an amber fill and a 24 × 24 viewBox.
- `icons/android/`: matching Android vector drawables. Apply a theme tint when displaying them.
- `manifest.json`: sprite dimensions, alpha bounds, pose names, alignment, and idle animation timings.
- `PROMPTS.md`: the complete generation prompts and identity reference relationship.
- `SHA256SUMS.txt`: checksums of every exported asset and metadata file.

## Sprite order

Read left-to-right, then top-to-bottom: idle, half blink, closed blink, downloading, success, error. Use the alpha bounds in the manifest and align the characters at bottom-center to avoid position shifts while blinking. Use nearest-neighbor sampling and retain the alpha channel.

The app blinks through frames 0, 1, 2, 1 while visible. Downloading uses frame 3 with a gentle vertical bob. Success and error use frames 4 and 5. Refresh and download glyphs animate in Compose while their operations are active. Source implementation is in `app/src/main/java/vn/mint/taivideo/ui/PixelArt.kt`.

## Palette

Amber `#F4C56B`, cream `#FFF1CB`, brown `#835200`, charcoal `#241D13`. The app background is `#181714`. Smaller action icons use native vectors for clear touch actions, while the generated sprites supply the character artwork.
