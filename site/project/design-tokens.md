# Design tokens

One JSON file, `design/tokens.json`, is the source of truth for the look of the web app, the Android app and **this site**.

| Token group | Contents |
| --- | --- |
| `accents` | Ember (default, the fox orange), Ocean, Moss, Iris, Graphite, each with a `light` and a `dark` value |
| `colors.light` / `colors.dark` | `bg`, `surface`, `surfaceAlt`, `hairline`, `text`, `textMuted`, `textFaint`, `online`, `idle`, `offline`, `danger` |
| `radius` | `card` 16, `control` 12, `small` 8, `pill` 999 |
| `space` | 4, 8, 12, 16, 24, 32 |
| `type` | system font stack, mono stack, size/line/weight scale |

```bash
node design/tools/gen-tokens.mjs          # writes web/src/styles/tokens.css and android/.../ui/Tokens.kt
node design/tools/gen-tokens.mjs --check  # CI: fail if the generated files are stale
```

Accent colours for the light theme are darkened so text in the accent passes WCAG AA (≥ 4.5:1) on the light surfaces; `web/tests/a11y.test.ts` checks every pair. This documentation site's CSS variables are generated from the same file by `site/.vitepress/gen.mjs`.
