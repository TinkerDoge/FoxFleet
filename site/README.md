# Foxfleet documentation site

VitePress, published to GitHub Pages at `https://tinkerdoge.github.io/FoxFleet/` (base path `/FoxFleet/`).

```bash
npm ci
npm run dev           # http://localhost:5173/FoxFleet/
npm run build         # generates reference pages, then builds .vitepress/dist
npm run check-links   # internal links/assets/anchors of the built site
```

Generated at build time from the code (gitignored): `reference/api.md` (OpenAPI), `reference/errors.md`, `hosting/environment.md`, `project/roadmap.md`, `.vitepress/theme/tokens.generated.css`.
