# Foxfleet documentation site

VitePress, published to GitHub Pages at `https://tinkerdoge.github.io/FoxFleet/` (base path `/FoxFleet/`).

```bash
npm ci
npm run dev           # http://localhost:5173/FoxFleet/
npm run build         # generates reference pages, then builds .vitepress/dist
npm run check-links   # internal links/assets/anchors of the built site
```

Generated at build time from the code (gitignored): `reference/api.md` (OpenAPI), `reference/errors.md`, `hosting/environment.md`, `project/roadmap.md`, `.vitepress/theme/tokens.generated.css`.

The roadmap uses the JSON block in `../docs/roadmap.html` as its single source for the offline tracker and the docs page. Update its date, stage, milestones, work items, and limitations when the project changes. Mark an item `Done` only when implemented; use `Next` for queued validation, `In progress` only for work actually underway, and `Later` for future plans. Each unfinished item needs a `doneWhen` completion criterion. Keep item IDs stable so offline personal ticks survive updates.

Keep `version` aligned with the root package version, `releasedVersion` for the latest published downloads, and `nextVersion` for the named unreleased work in `CHANGELOG.md`. A package bump does not itself mean a release has been published. Mark newly implemented, unreleased cards with `release: "Unreleased"` so source features are not mistaken for current downloads.

`npm run gen` validates the roadmap version against the root `package.json`, the upcoming version against `CHANGELOG.md`, and provider rows against `server/config.js`. It generates both `project/roadmap.md` and `.vitepress/theme/roadmap.generated.json`. Provider capabilities on the docs page come directly from the server. Edit the source data or `.vitepress/roadmap.mjs`, not the generated files; verify changes with `npm run build` and `npm run check-links`.
