#!/usr/bin/env node
// Regenerates NOTICE.md from the real dependency metadata: web/package.json + installed node_modules (npm part) and
// android/gradle/libs.versions.toml + the Gradle module cache (Android part; run a Gradle build first so POMs are cached).
// Usage: (cd web && npm ci) && node design/tools/gen-notice.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; import { homedir } from 'node:os';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const lic = (j) => (typeof j.license === 'string' ? j.license : j.license?.type ?? j.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN');
const pkg = JSON.parse(readFileSync(join(root, 'web/package.json'), 'utf8'));
const npmRow = (n, where, dir = 'web') => { const p = join(root, dir, 'node_modules', n, 'package.json'); if (!existsSync(p)) throw new Error(`install ${dir} deps first (missing ${n})`); const j = JSON.parse(readFileSync(p, 'utf8')); return `| ${n} ${j.version} | ${lic(j)} | ${where} |`; };
const runtime = Object.keys(pkg.dependencies).sort().map((n) => npmRow(n, '`web/` (bundled into the web app)'));
const dev = Object.keys(pkg.devDependencies).sort().map((n) => npmRow(n, '`web/` (build/test time only, not shipped)'));
// Documentation site (site/, VitePress): what its built output (site/.vitepress/dist) contains.
const docsBundled = ['vitepress', 'vue', '@vueuse/core', '@vueuse/integrations', 'focus-trap', 'tabbable', 'minisearch', 'mark.js', '@docsearch/css'].map((n) => npmRow(n, '`site/` (bundled into the documentation site)', 'site'));
const toml = readFileSync(join(root, 'android/gradle/libs.versions.toml'), 'utf8');
const versions = Object.fromEntries([...toml.matchAll(/^(\w+) = "([^"]+)"/gm)].map((m) => [m[1], m[2]]));
const libs = [...toml.matchAll(/^([\w-]+) = \{ group = "([^"]+)", name = "([^"]+)"(?:, version(?:\.ref)? = "([^"]+)")? \}/gm)].map((m) => ({ group: m[2], name: m[3], version: versions[m[4]] ?? m[4] ?? '(BOM)' }));
const cache = join(homedir(), '.gradle/caches/modules-2/files-2.1');
const walk = (d, out = []) => { if (!existsSync(d)) return out; for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, out) : p.endsWith('.pom') && out.push(p); } return out; };
const poms = (g, n) => walk(join(cache, g, n));
const licenceOf = (g, n) => { for (const p of poms(g, n)) { const m = /<license>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(readFileSync(p, 'utf8')); if (m) return m[1].trim(); } return 'see the artefact POM'; };
const android = libs.filter((l) => !/(junit|robolectric|roborazzi|ui-test|tooling|coroutines-test)/.test(l.name)).sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name)).map((l) => `| ${l.group}:${l.name} ${l.version} | ${licenceOf(l.group, l.name)} | \`android/\` |`);
const wrapper = readFileSync(join(root, 'android/gradle/wrapper/gradle-wrapper.properties'), 'utf8').match(/gradle-([\d.]+)-bin/)?.[1];
writeFileSync(join(root, 'NOTICE.md'), `# Third-party notices

Foxfleet is MIT licensed (see \`LICENSE\`). This file lists what it bundles or builds against. Most of it is **generated** by
\`node design/tools/gen-notice.mjs\` from \`web/package.json\` (+ installed packages) and \`android/gradle/libs.versions.toml\` (+ the Gradle module cache), so re-run it when dependencies change.
The hub server itself has **no** runtime dependencies (Node standard library only).

## Web app (bundled)

| Package | Licence | Where |
| --- | --- | --- |
${runtime.join('\n')}
| noVNC (vendored, unmodified) | MPL-2.0; individual files may carry their own header (core/des.js: BSD-style) | \`web/src/vendor/novnc/\` (lazy-loaded screen view) and \`android/app/src/main/assets/novnc/\` |
| pako (inside noVNC) | MIT (+ zlib) | \`web/src/vendor/novnc/vendor/pako/\`, same under the Android assets; licence text in \`vendor/pako/LICENSE\` |

MPL-2.0 is file-level copyleft: the noVNC files are unmodified and keep their headers; the full texts ship in \`web/src/vendor/novnc/LICENSE.txt\`.
DOMPurify is dual-licensed (MPL-2.0 OR Apache-2.0); either applies.

## Web build tooling (not shipped)

| Package | Licence | Where |
| --- | --- | --- |
${dev.join('\n')}

Vite bundles only the runtime packages above into \`web/dist\`; none of the build tools end up in it.

## Android app (direct dependencies; transitive AndroidX/Kotlin artefacts are Apache-2.0)

| Library | Licence | Where |
| --- | --- | --- |
${android.join('\n')}
| Gradle wrapper (gradle-wrapper.jar, Gradle ${wrapper}) | Apache-2.0 | \`android/gradle/wrapper/\` (committed build tool, not shipped in the APK) |

Notes: the ML Kit / Play services code scanner is **not** redistributed in this repo; Google Play services provides it at runtime under Google's
terms (ML Kit Terms of Service / Android SDK Licence as reported by the artefact POMs).

## Documentation site (\`site/\`, published to GitHub Pages)

The site is built with VitePress. Its output bundles the packages below (all resolved from \`site/package-lock.json\`); the site makes **no third-party requests** at runtime (no CDN fonts, analytics or icon services).

| Package | Licence | Where |
| --- | --- | --- |
${docsBundled.join('\n')}
| Inter (14 \`.woff2\` files, shipped inside VitePress's default theme and copied to the site output) | SIL OFL 1.1, Copyright (c) 2016 The Inter Project Authors | \`site/.vitepress/dist/assets/inter-*.woff2\`; full licence text in \`LICENSES/Inter-OFL-1.1.txt\` (also published at \`/licenses/Inter-OFL-1.1.txt\` on the site) |

Other VitePress build-time dependencies (Vite, Rollup, esbuild, Shiki, markdown-it and friends) are not shipped in the output.

## Fonts

Nunito (SIL OFL 1.1) is used only to render the wordmark PNGs at design time (\`design/tools/make-wordmarks.py\`); the font file is not included.

## Brand images (AI-generated)

The wooden fox mascot in \`design/brand/\` and the Android drawables was **generated with AI image tools** (ChatGPT image generation for the first concept, Grok Imagine for the final variation) and post-processed locally. It is published under the same MIT licence as the code. See \`design/brand/README.md\`.
`);
console.log('wrote NOTICE.md');
