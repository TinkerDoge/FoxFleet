# Brand assets

The Foxfleet mascot is a hand-carved-wood style fox head ("W3").

**Provenance:** AI-generated. The first concept (W1) came from ChatGPT image generation; the published variation (W3) was generated with Grok Imagine (Quality, 1:1) using W1 as a style reference. The prompt is in `prompt-W3.txt`. The raw output was cut out locally (rembg + closed-form alpha matting) and sized into an Android adaptive-icon foreground. No third-party artwork was used as input. Because the image is AI-generated, copyright protection may be limited in some jurisdictions; it is offered under the MIT licence regardless.

| File | Use |
| --- | --- |
| `option-W3.png` | Full 1024 px artwork on the warm off-white background |
| `option-W3-transparent.png` | Cut-out, used in-app and on the web |
| `option-W3-adaptive-fg.png` | Android adaptive-icon foreground |
| `option-W3-icon-preview.png` | Icon preview |
| `wordmark-light.png` / `wordmark-dark.png` | "Foxfleet" lockups (built by `tools/make-wordmarks.py`, Nunito ExtraBold) |

Accent: `#D9653B` (light) / `#F08A5D` (dark), see `../tokens.json`.

## Regenerating the wordmarks

`design/tools/make-wordmarks.py` needs Pillow and the Nunito variable font (SIL OFL 1.1, not included). Point `NUNITO_FONT` at `Nunito-VariableFont_wght.ttf`, pass the path as the first argument, or drop it into `design/fonts/` (git-ignored). The script exits with a clear message if the font is missing.
