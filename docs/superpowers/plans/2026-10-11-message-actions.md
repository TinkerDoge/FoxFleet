# Message Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram/Discord-style message actions in both apps (long-press menu, double-tap heart, swipe to reply, quote replies, hide-for-me, Retry/Edit, Share), plus Hermes agents reacting through a `REACT:` line.

**Architecture:** One shared parser change (`REACT:` lines) in hub, web and Android, pinned by `contract/media-tags.vectors.json`. The hub derives agent reactions from the transcript on read and stores a per-account hidden-message list beside reactions. Each client gets one pure helper module (quote, excerpt, visibility, menu actions) with unit tests, and the UI only wires gestures to those helpers.

**Tech Stack:** Node 22 (`node:test`), Preact + TypeScript + Vitest, Kotlin + Jetpack Compose + Robolectric/Roborazzi.

**Spec:** `docs/superpowers/specs/2026-10-11-message-actions-design.md`

**Branch:** `feat/message-actions` (already created; the spec is committed there).

---

## Conventions for every task

- Repo root: `E:\Code\FoxFleet`. Commands use Git Bash (`cd /e/Code/FoxFleet`).
- Hub tests: `node --test server/test/<file>.test.js`. Full gate: `npm test` (it enforces the minimum in `scripts/hub-tests.min`).
- Web tests: `cd web && npx vitest run tests/<file>` ; typecheck `npm run typecheck`.
- Android tests: `cd android && ./gradlew :app:testDebugUnitTest --tests "<fqcn>"`.
- Some hub test files fail identically on `main` on Windows (cli, agent-note golden YAML parts, connector-doctor, machines, media symlink). Compare against `main` before treating such a failure as yours.
- Commit message trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
| --- | --- |
| `docs/superpowers/specs/2026-10-11-message-actions-design.md` | Small amendments decided while planning (Task 0) |
| `server/media-tags.js` | `takeReact`, `emojiShaped`; `parseMedia` returns `react`; `parseStreaming` hides a partial `REACT:` line |
| `web/src/lib/mediaTags.ts` | Same as hub |
| `android/.../ui/chat/MediaTags.kt` | Same as hub; `ParsedMedia.react` |
| `contract/media-tags.vectors.json` | 9 new vectors with `react` |
| `server/reactions.js` | Hidden list in the store; `agentReactions`, `mergeReactions` |
| `server/index.js` | `/hidden` route, snapshot `hidden`, derived agent reactions, `agentReactions` capability for Hermes |
| `contract/openapi.json` | `/hidden` path, `Reactions.hidden` |
| `connector/foxfleet-connector.mjs`, `contract/agent-note.golden.txt` | One agent-note line |
| `design/icons/icons.json` (+ generated `web/src/icons/paths.ts`, `android/.../ui/FoxIcons.kt`) | `reply`, `share`, `selectAll`, `edit` |
| `web/src/chat/messageActions.ts` (new) | Pure helpers |
| `web/src/chat/MessageMenu.tsx` (new) | Popover menu |
| `web/src/chat/Reactions.tsx`, `Message.tsx`, `ChatView.tsx`, `Composer.tsx`, `store.ts`, `api/client.ts`, `i18n/en.json`, `styles/polish.css` | Wiring |
| `android/.../ui/chat/MessageActions.kt` (new) | Pure helpers |
| `android/.../ui/components/MessageMenu.kt` (new) | Menu sheet, select dialog, reply quote, heart pop, swipe wrapper |
| `android/.../data/Models.kt`, `data/HubApi.kt`, `ui/chat/ChatState.kt`, `ui/chat/Messenger.kt`, `HubViewModel.kt`, `ui/screens/ChatScreen.kt`, `MainActivity.kt` | Wiring |
| Tests: `server/test/media-tags.test.js`, `server/test/reactions.test.js`, `web/tests/media.test.tsx`, `web/tests/message-actions.test.tsx` (new), `android/.../ui/MediaTagsTest.kt`, `android/.../ui/MessageActionsTest.kt` (new), `android/.../screenshots/MessengerScreenshotTest.kt` | |

---

### Task 0: Spec amendments

Decisions made while reading the code; record them so reviewers check against the right spec.

**Files:** Modify `docs/superpowers/specs/2026-10-11-message-actions-design.md`

- [ ] **Step 1: Apply the amendments**

Add this section right before `## Out of scope`:

```markdown
### Amendments made while planning

- **Edit** is offered on Hermes agents (`kind === 'hermes'`); the bundled Hermes catalog always has `/undo` with availability `chat`.
- **React and Delete** are left out of the menu (not greyed) until the message has a hub id; the menu never shows a control that cannot work.
- **Undo after hiding** is an inline status row at the bottom of the transcript ("Message hidden · Undo", 5 s), like the existing reaction-error line. Neither app has a toast/snackbar system and this round does not add one.
- **Copy** gives no extra toast: Android 13+ shows its own clipboard confirmation, and on web the menu closing is the feedback.
- **`REACT:` grammar** (same in all three parsers): a line that is optional spaces/tabs, `REACT:`, optional spaces/tabs, a token of 1–32 UTF-16 units with no space, tab, CR or LF, optional spaces/tabs. The token must be *emoji-shaped*: no ASCII letters, and at least one code point ≥ U+2000. Emoji-shaped lines are removed from view; the hub applies the reaction only when the token also passes `validEmoji` (one RGI emoji). `parseMedia` returns the first emoji-shaped token as `react`.
- **Delete** on the menu reads "Delete for me".
```

- [ ] **Step 2: Commit**

```bash
cd /e/Code/FoxFleet
git add docs/superpowers/specs/2026-10-11-message-actions-design.md
git commit -m "docs: message actions spec amendments from planning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: `REACT:` in the hub parser and the shared vectors

**Files:**
- Modify: `server/media-tags.js`
- Modify: `contract/media-tags.vectors.json`
- Test: `server/test/media-tags.test.js`

- [ ] **Step 1: Add the vectors**

Run this once (it appends to the existing list and keeps the file's 2-space JSON format):

```bash
cd /e/Code/FoxFleet
node -e '
const fs = require("fs"), f = "contract/media-tags.vectors.json", j = JSON.parse(fs.readFileSync(f, "utf8"));
j.vectors.push(
  { name: "react directive", input: "Love it!\nREACT: ❤️", text: "Love it!", media: [], react: "❤️" },
  { name: "react skin tone", input: "REACT: 👍🏽\nNice", text: "Nice", media: [], react: "👍🏽" },
  { name: "react zwj, no space, padded", input: "Done.\n  REACT:👩‍💻  ", text: "Done.", media: [], react: "👩‍💻" },
  { name: "react inside a fence stays", input: "```\nREACT: ❤️\n```", text: "```\nREACT: ❤️\n```", media: [] },
  { name: "react mentioned inline stays", input: "Use REACT: ❤️ to react", text: "Use REACT: ❤️ to react", media: [] },
  { name: "react twice: first wins, both removed", input: "REACT: 🎉\nGreat\nREACT: ❤️", text: "Great", media: [], react: "🎉" },
  { name: "react with a word stays", input: "REACT: like", text: "REACT: like", media: [] },
  { name: "react only", input: "REACT: 😮", text: "", media: [], react: "😮" },
  { name: "react with media", input: "REACT: ❤️\nMEDIA:/tmp/a.png", text: "", media: [{ ref: "/tmp/a.png", kind: "image" }], react: "❤️" },
);
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");'
git diff --stat contract/media-tags.vectors.json
```

Expected: only insertions in that file. If the diff shows the whole file rewritten (trailing newline or indentation differs), restore it with `git checkout contract/media-tags.vectors.json` and append the objects by hand before the closing `]`.

- [ ] **Step 2: Make the hub test check `react`**

In `server/test/media-tags.test.js`, change the vector loop to:

```js
for (const v of vectors) test(`media tags: ${v.name}`, () => {
  const r = parseMedia(v.input);
  assert.equal(r.text, v.text);
  assert.deepEqual(r.media.map((m) => ({ ref: m.ref, kind: m.kind, ...(m.voice ? { voice: true } : {}) })), v.media);
  assert.equal(r.react ?? null, v.react ?? null);
});
```

And add after the existing `streaming hides a tag whose end has not arrived` test:

```js
test('streaming hides a REACT: line until the reply is done', () => {
  assert.equal(parseStreaming('Nice\nREAC').text, 'Nice');
  assert.equal(parseStreaming('Nice\nREACT: ❤').text, 'Nice');
  assert.equal(parseStreaming('Nice\nREACT: ❤️\nMore').text, 'Nice\nMore');
  assert.equal(parseStreaming('Really good').text, 'Really good');
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `node --test server/test/media-tags.test.js`
Expected: FAIL on the new `react ...` vectors (`react` is `undefined` / the line is still in `text`) and on the streaming test.

- [ ] **Step 4: Implement in `server/media-tags.js`**

Directly after the `mask` function, add:

```js
// REACT: <one emoji> on its own line is the agent's reaction to the user's message. The hub applies it; the apps never show the line.
const REACT_LINE = /^[ \t]*REACT:[ \t]*([^ \t\r\n]{1,32})[ \t]*$/gm;
const PARTIAL_REACT = /(?:^|\n)[ \t]*R(?:E(?:A(?:C(?:T(?::[^\n]*)?)?)?)?)?$/;
/** Emoji-shaped: no ASCII letters and at least one code point from U+2000 up. The hub still checks validEmoji before applying it. */
export const emojiShaped = (s) => !/[A-Za-z]/.test(s) && [...s].some((c) => c.codePointAt(0) >= 0x2000);
/** takeReact(text) -> { text: <REACT: lines removed>, react: <first one's token> | null }. Lines in code or quotes stay. */
export function takeReact(text) {
  if (!text.includes('REACT:')) return { text, react: null };
  const scan = mask(text), spans = []; let react = null;
  for (const m of scan.matchAll(REACT_LINE)) {
    if (!emojiShaped(m[1])) continue;
    react ??= m[1];
    const end = m.index + m[0].length; spans.push([m.index, text[end] === '\n' ? end + 1 : end]);
  }
  if (!spans.length) return { text, react: null };
  let out = text; for (const [a, b] of spans.reverse()) out = out.slice(0, a) + out.slice(b);
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), react };
}
```

Change the top of `parseMedia` and its two returns:

```js
export function parseMedia(input) {
  const { text, react } = takeReact(typeof input === 'string' ? input : '');
  if (!text.includes('MEDIA:') && !text.includes('[[') && !text.includes('](') && !text.includes('http') && !text.includes('data:image')) return { text, media: [], react };
```

and the last line of `parseMedia`:

```js
  return { text: out, media, react };
```

Replace `parseStreaming` with:

```js
/** While a reply is still streaming, hide a tag whose end has not arrived yet (it is never shown half-written). */
export function parseStreaming(input) {
  // A tag is held back until its line is finished (a spaced path may still grow): never a half card, never a half-written path in the text.
  // A last line that could still become a REACT: line is held back the same way.
  const text = typeof input === 'string' ? input : '';
  const cuts = [text.search(/[`"'*_]{0,3}MEDIA:[^\n]*$/i), text.search(PARTIAL_REACT)].filter((i) => i >= 0);
  const r = parseMedia(cuts.length ? text.slice(0, Math.min(...cuts)) : text);
  return { ...r, text: r.text.replace(/\[\[[a-z_]*\]?$/, '').trimEnd() };
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `node --test server/test/media-tags.test.js server/test/tool-media.test.js`
Expected: PASS (all old vectors still pass; `react` is `null` for them).

- [ ] **Step 6: Commit**

```bash
git add server/media-tags.js server/test/media-tags.test.js contract/media-tags.vectors.json
git commit -m "feat(hub): REACT: line in the shared tag parser, with contract vectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `REACT:` in the web parser

**Files:**
- Modify: `web/src/lib/mediaTags.ts`
- Test: `web/tests/media.test.tsx`

- [ ] **Step 1: Make the conformance test check `react`**

In `web/tests/media.test.tsx`, inside the `it.each(... 'conformance: %s' ...)` body, add as the last line:

```ts
  expect(r.react ?? null).toBe(v.react ?? null);
```

and add a new test right after that `it.each` block:

```ts
it('streaming hides a REACT: line until the reply is done', () => {
  expect(parseStreaming('Nice\nREAC').text).toBe('Nice');
  expect(parseStreaming('Nice\nREACT: ❤').text).toBe('Nice');
  expect(parseStreaming('Nice\nREACT: ❤️\nMore').text).toBe('Nice\nMore');
  expect(parseStreaming('Really good').text).toBe('Really good');
});
```

If `parseStreaming` is not imported in that file yet, extend its import from `'../src/lib/mediaTags'` to include it.

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && npx vitest run tests/media.test.tsx`
Expected: FAIL on the `react` vectors and the streaming test.

- [ ] **Step 3: Implement in `web/src/lib/mediaTags.ts`**

After the `mask` function add:

```ts
// REACT: <one emoji> on its own line is the agent's reaction to the user's message. The hub applies it; the apps never show the line.
const REACT_LINE = /^[ \t]*REACT:[ \t]*([^ \t\r\n]{1,32})[ \t]*$/gm;
const PARTIAL_REACT = /(?:^|\n)[ \t]*R(?:E(?:A(?:C(?:T(?::[^\n]*)?)?)?)?)?$/;
/** Emoji-shaped: no ASCII letters and at least one code point from U+2000 up (same rule as the hub). */
export const emojiShaped = (s: string) => !/[A-Za-z]/.test(s) && [...s].some((c) => c.codePointAt(0)! >= 0x2000);
/** takeReact(text) -> { text: <REACT: lines removed>, react: <first one's token> | null }. Lines in code or quotes stay. */
export function takeReact(text: string): { text: string; react: string | null } {
  if (!text.includes('REACT:')) return { text, react: null };
  const scan = mask(text), spans: [number, number][] = []; let react: string | null = null;
  for (const m of scan.matchAll(REACT_LINE)) {
    if (!emojiShaped(m[1])) continue;
    react ??= m[1];
    const end = m.index! + m[0].length; spans.push([m.index!, text[end] === '\n' ? end + 1 : end]);
  }
  if (!spans.length) return { text, react: null };
  let out = text; for (const [a, b] of spans.reverse()) out = out.slice(0, a) + out.slice(b);
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), react };
}
```

Change `parseMedia`:

```ts
export function parseMedia(input: unknown): { text: string; media: MediaRef[]; react: string | null } {
  const { text, react } = takeReact(typeof input === 'string' ? input : '');
  if (!text.includes('MEDIA:') && !text.includes('[[') && !text.includes('](') && !text.includes('http') && !text.includes('data:image')) return { text, media: [], react };
```

and its last line:

```ts
  return { text: out, media, react };
```

Replace `parseStreaming`:

```ts
/** While a reply is still streaming, hide a tag whose end has not arrived yet (it is never shown half-written). */
export function parseStreaming(input: unknown) {
  // A tag is held back until its line is finished (a spaced path may still grow): never a half card, never a half-written path in the text.
  // A last line that could still become a REACT: line is held back the same way.
  const text = typeof input === 'string' ? input : '';
  const cuts = [text.search(/[`"'*_]{0,3}MEDIA:[^\n]*$/i), text.search(PARTIAL_REACT)].filter((i) => i >= 0);
  const r = parseMedia(cuts.length ? text.slice(0, Math.min(...cuts)) : text);
  return { ...r, text: r.text.replace(/\[\[[a-z_]*\]?$/, '').trimEnd() };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run tests/media.test.tsx && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
cd /e/Code/FoxFleet
git add web/src/lib/mediaTags.ts web/tests/media.test.tsx
git commit -m "feat(web): REACT: line in the tag parser (shared vectors)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `REACT:` in the Android parser

**Files:**
- Modify: `android/app/src/main/java/dev/foxfleet/app/ui/chat/MediaTags.kt`
- Test: `android/app/src/test/java/dev/foxfleet/app/ui/MediaTagsTest.kt`

- [ ] **Step 1: Make the vector test check `react`**

In `MediaTagsTest.conformsToTheSharedVectors`, replace the failure check line with:

```kotlin
            val wantReact = v["react"]?.jsonPrimitive?.content
            if (r.text != v["text"]!!.jsonPrimitive.content || got != want || r.react != wantReact) failures += "${v["name"]!!.jsonPrimitive.content}: text='${r.text}' media=$got react=${r.react}"
```

Add a test:

```kotlin
    @Test fun streamingHidesAReactLineUntilDone() {
        assertEquals("Nice", MediaTags.parseStreaming("Nice\nREAC").text)
        assertEquals("Nice", MediaTags.parseStreaming("Nice\nREACT: ❤").text)
        assertEquals("Nice\nMore", MediaTags.parseStreaming("Nice\nREACT: ❤️\nMore").text)
        assertEquals("Really good", MediaTags.parseStreaming("Really good").text)
    }
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.ui.MediaTagsTest"`
Expected: compile error (`react` unknown) — that is the failing state.

- [ ] **Step 3: Implement in `MediaTags.kt`**

Change the data class:

```kotlin
data class ParsedMedia(val text: String, val media: List<TagMedia>, val react: String? = null)
```

Inside `object MediaTags`, after `mask`, add:

```kotlin
    // REACT: <one emoji> on its own line is the agent's reaction to the user's message. The hub applies it; the apps never show the line.
    private val reactLine = Regex("^[ \\t]*REACT:[ \\t]*([^ \\t\\r\\n]{1,32})[ \\t]*$", RegexOption.MULTILINE)
    private val partialReact = Regex("(?:^|\\n)[ \\t]*R(?:E(?:A(?:C(?:T(?::[^\\n]*)?)?)?)?)?$")
    /** Emoji-shaped: no ASCII letters and at least one code point from U+2000 up (same rule as the hub). */
    fun emojiShaped(s: String) = s.none { it in 'A'..'Z' || it in 'a'..'z' } && s.codePoints().anyMatch { it >= 0x2000 }
    /** The text with REACT: lines removed, and the first one's token. Lines in code or quotes stay. */
    fun takeReact(input: String): Pair<String, String?> {
        if (!input.contains("REACT:")) return input to null
        val scan = mask(input); val spans = ArrayList<IntArray>(); var react: String? = null
        for (m in reactLine.findAll(scan)) {
            val tok = m.groupValues[1]; if (!emojiShaped(tok)) continue
            if (react == null) react = tok
            val end = m.range.last + 1; spans += intArrayOf(m.range.first, if (end < input.length && input[end] == '\n') end + 1 else end)
        }
        if (spans.isEmpty()) return input to null
        var out = input; for (s in spans.asReversed()) out = out.substring(0, s[0]) + out.substring(s[1])
        return out.replace(Regex("[ \\t]+\\n"), "\n").replace(Regex("\\n{3,}"), "\n\n").trim() to react
    }
```

Change the start and end of `parse`:

```kotlin
    fun parse(input: String): ParsedMedia {
        val (text, react) = takeReact(input)
        if (!text.contains("MEDIA:") && !text.contains("[[") && !text.contains("](") && !text.contains("http") && !text.contains("data:image")) return ParsedMedia(text, emptyList(), react)
```

```kotlin
        return ParsedMedia(out, media, react)
```

Replace `parseStreaming`:

```kotlin
    /** While a reply streams, a tag (or a line that may become REACT:) is held back until its line is finished. */
    fun parseStreaming(input: String): ParsedMedia {
        val cut = listOfNotNull(Regex("""[`"'*_]{0,3}MEDIA:[^\n]*$""", RegexOption.IGNORE_CASE).find(input)?.range?.first, partialReact.find(input)?.range?.first).minOrNull() ?: -1
        val r = parse(if (cut >= 0) input.substring(0, cut) else input)
        return r.copy(text = r.text.replace(Regex("""\[\[[a-z_]*]?$"""), "").trimEnd())
    }
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.ui.MediaTagsTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Code/FoxFleet
git add android/app/src/main/java/dev/foxfleet/app/ui/chat/MediaTags.kt android/app/src/test/java/dev/foxfleet/app/ui/MediaTagsTest.kt
git commit -m "feat(android): REACT: line in the tag parser (shared vectors)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Hidden-message list in the reaction store

**Files:**
- Modify: `server/reactions.js`
- Test: `server/test/reactions.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `server/test/reactions.test.js`:

```js
test('hidden messages: idempotent, per conversation, survive reload, cleaned with sessions, agents and accounts', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-hidden-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'reactions.json');
  await writeFile(file, JSON.stringify({ version: 1, rows: [] })); // a 0.3.8 store loads with nothing hidden
  const s = await reactionStore(file);
  assert.deepEqual(s.hidden('a', 's'), []);
  await s.hide('a', 's', 'm1', true); await s.hide('a', 's', 'm1', true); await s.hide('a', 's', 'm2', true);
  await s.hide('a', 'other', 'm9', true); await s.hide('b', 's', 'm1', true);
  assert.deepEqual(s.hidden('a', 's'), ['m1', 'm2']);
  const again = await reactionStore(file);
  assert.deepEqual(again.hidden('a', 's'), ['m1', 'm2']);
  await again.hide('a', 's', 'm2', false); await again.hide('a', 's', 'm2', false);
  assert.deepEqual(again.hidden('a', 's'), ['m1']);
  await again.retain('a', ['s']); assert.deepEqual(again.hidden('a', 'other'), []); assert.deepEqual(again.hidden('a', 's'), ['m1']);
  await again.remove('a', 's'); assert.deepEqual(again.hidden('a', 's'), []);
  assert.deepEqual(again.hidden('b', 's'), ['m1']); await again.remove('b'); assert.deepEqual(again.hidden('b', 's'), []);
  await again.hide('c', 's', 'x', true); await again.clear(); assert.deepEqual(again.hidden('c', 's'), []);
  await assert.rejects(async () => again.hide('a', 's', '', true), /Invalid message ID/);
});

test('hidden messages never expire on their own (reactions do)', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-hidden-age-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 1_000_000; const s = await reactionStore(path.join(dir, 'reactions.json'), { now: () => clock, retentionMs: 1000 });
  await s.hide('a', 's', 'm', true); clock += 5000; await s.hide('a', 's', 'n', true);
  assert.deepEqual(s.hidden('a', 's'), ['m', 'n']);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test server/test/reactions.test.js`
Expected: FAIL with `s.hidden is not a function`.

- [ ] **Step 3: Implement in `server/reactions.js`**

Replace the loading block, `mutate`, and the cleanup methods, and add `hide` / `hidden`. The whole `reactionStore` becomes:

```js
export async function reactionStore(file, { now = () => Date.now(), retentionMs = 90 * 86400000 } = {}) {
  let rows = [], hidden = []; // hidden: [{ agent, session, message, at }], this account's "delete for me" list; it never expires on its own
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(data.rows)) throw new Error('Invalid reaction store');
    rows = data.rows; hidden = Array.isArray(data.hidden) ? data.hidden : [];
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let pending = Promise.resolve();
  function mutate(change) {
    const work = pending.then(async () => {
      const next = rows.filter(r => r.at > now() - retentionMs).map(r => ({ ...r })), nextHidden = hidden.map(h => ({ ...h })); change(next, nextHidden);
      const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
      await mkdir(path.dirname(file), { recursive: true });
      try { await writeFile(tmp, JSON.stringify({ version: 2, rows: next, hidden: nextHidden }), { mode: 0o600, flag: 'wx' }); await rename(tmp, file); rows = next; hidden = nextHidden; }
      finally { await unlink(tmp).catch(() => {}); }
    });
    pending = work.catch(() => {}); return work;
  }
  const drop = (list, agent, session) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].agent === agent && (session === undefined || list[i].session === session)) list.splice(i, 1); };
  return {
    list(agent, session) { /* unchanged: keep the existing body */ },
    set(agent, session, message, emoji, actor, present) { /* unchanged: keep the existing body */ },
    /** "Delete for me": hide (present) or show again one message in this account's view. Idempotent. */
    hide(agent, session, message, present) {
      if (typeof message !== 'string' || !message || message.length > 200) throw fault(400, 'Invalid message ID');
      return mutate((_, next) => {
        const i = next.findIndex(h => h.agent === agent && h.session === session && h.message === message);
        if (!present) { if (i >= 0) next.splice(i, 1); return; }
        if (i >= 0) return;
        if (next.length >= 50000 || next.filter(h => h.agent === agent && h.session === session).length >= 5000) throw fault(409, 'Hidden message limit reached');
        next.push({ agent, session, message, at: now() });
      });
    },
    hidden(agent, session) { return hidden.filter(h => h.agent === agent && h.session === session).map(h => h.message); },
    remove(agent, session) { return mutate((next, nextHidden) => { drop(next, agent, session); drop(nextHidden, agent, session); }); },
    retain(agent, sessions) { const keep = new Set(sessions); return mutate((next, nextHidden) => { for (const list of [next, nextHidden]) for (let i = list.length - 1; i >= 0; i--) if (list[i].agent === agent && !keep.has(list[i].session)) list.splice(i, 1); }); },
    clear() { return mutate((next, nextHidden) => { next.length = 0; nextHidden.length = 0; }); },
    flush: () => pending,
  };
}
```

Keep the existing bodies of `list` and `set` exactly as they are (only the placeholders above stand for them). `set` still calls `mutate(next => …)`; its single parameter keeps working.

Also update the file's header comment to: `// Account-local reactions and hidden messages. The caller verifies conversation/message access and supplies the authenticated actor.`

- [ ] **Step 4: Run and watch it pass**

Run: `node --test server/test/reactions.test.js`
Expected: PASS (old and new tests).

- [ ] **Step 5: Commit**

```bash
git add server/reactions.js server/test/reactions.test.js
git commit -m "feat(hub): per-account hidden-message list in the reaction store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Hub route, derived agent reactions, capability, contract

**Files:**
- Modify: `server/reactions.js`, `server/index.js:230`, `server/index.js:505-524`, `contract/openapi.json`
- Test: `server/test/reactions.test.js`

- [ ] **Step 1: Write the failing tests**

Add `agentReactions, mergeReactions` to the import from `'../reactions.js'` at the top of `server/test/reactions.test.js`, then append:

```js
test('agent reactions come from REACT: lines and land on the nearest earlier user message', () => {
  const bot = { id: 'agent:atlas', name: 'Atlas', kind: 'agent' };
  const msgs = [
    { id: 'u1', role: 'user', content: 'hello' }, { id: 'a1', role: 'assistant', content: 'Hi!\nREACT: 👋' },
    { id: 'u2', role: 'user', content: 'thanks' }, { id: 'a2', role: 'assistant', content: 'REACT: ❤️\nREACT: 🎉' },
    { role: 'user', content: 'no id yet' }, { id: 'a3', role: 'assistant', content: 'REACT: 👍👍' }, // two emoji: shaped, but not one RGI emoji
    { id: 'a4', role: 'assistant', content: '```\nREACT: 🦊\n```' },
  ];
  assert.deepEqual(agentReactions(msgs, bot), [{ message: 'u1', emoji: '👋', actor: bot }, { message: 'u2', emoji: '❤️', actor: bot }]);
  const human = { id: 'user:u', name: 'Owner', kind: 'human' };
  const merged = mergeReactions({ u2: [{ emoji: '❤️', actors: [human, bot] }] }, agentReactions(msgs, bot));
  assert.deepEqual(merged.u2, [{ emoji: '❤️', actors: [human, bot] }]); // an actor counts once
  assert.deepEqual(merged.u1, [{ emoji: '👋', actors: [bot] }]);
});

test('HTTP: agent REACT: lines show as reactions, and hiding is per account and idempotent', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-hide-http-'));
  const hub = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true });
  await new Promise(r => hub.listen(0, '127.0.0.1', r));
  t.after(async () => { hub.closeAllConnections(); await new Promise(r => hub.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 5 }); });
  const call = (p, method = 'GET', body, token) => fetch(`http://127.0.0.1:${hub.address().port}${p}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const added = await (await call('/api/connections', 'POST', { name: 'scribe', kind: 'mcp-inbox' })).json();
  const sent = await call('/api/agents/scribe/chat', 'POST', { messages: [{ role: 'user', content: 'I fixed the bug' }] });
  const sid = sent.headers.get('x-hermes-session-id'); await sent.text();
  const rpc = await (await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hub_post_message', arguments: { thread_id: sid, text: 'Nice work!\nREACT: ❤️' } } }, added.inboxToken)).json();
  assert.equal(rpc.result.isError, false);
  const msgs = (await (await call(`/api/agents/scribe/sessions/${sid}/messages`)).json()).messages;
  const user = msgs.find(m => m.role === 'user'), reply = msgs.find(m => m.role === 'assistant');
  const snap = await (await call(`/api/agents/scribe/sessions/${sid}/reactions`)).json();
  assert.deepEqual(snap.messages[user.id], [{ emoji: '❤️', actors: [{ id: 'agent:scribe', name: 'scribe', kind: 'agent' }] }]);
  assert.deepEqual(snap.hidden, []);
  const hiddenUrl = `/api/agents/scribe/sessions/${sid}/hidden`;
  assert.equal((await call(hiddenUrl, 'PUT', { message_id: 'nope' })).status, 404);
  const h1 = await (await call(hiddenUrl, 'PUT', { message_id: reply.id })).json();
  const h2 = await (await call(hiddenUrl, 'PUT', { message_id: reply.id })).json();
  assert.deepEqual(h1.hidden, [reply.id]); assert.deepEqual(h2.hidden, [reply.id]);
  assert.deepEqual((await (await call(`/api/agents/scribe/sessions/${sid}/reactions`)).json()).hidden, [reply.id]);
  assert.deepEqual((await (await call(hiddenUrl, 'DELETE', { message_id: reply.id })).json()).hidden, []);
  const agents = (await (await call('/api/agents')).json()).agents;
  assert.equal(agents.find(a => a.name === 'scribe').capabilities.agentReactions, true);
});
```

If the agent's `name` in the snapshot differs (e.g. the store keeps a `label`), adjust the expected actor `name` to `m.label || m.name` as the hub computes it; the `id` and `kind` must match exactly.

- [ ] **Step 2: Run and watch it fail**

Run: `node --test server/test/reactions.test.js`
Expected: FAIL (`agentReactions` is not exported; `/hidden` returns 404/405).

- [ ] **Step 3: Add the pure helpers to `server/reactions.js`**

At the top add `import { parseMedia } from './media-tags.js';` and after `validEmoji` add:

```js
/** Reactions agents write in their replies (a REACT: line). Each lands on the nearest earlier user message with an id. Derived on read, never stored. */
export function agentReactions(messages, actor) {
  const out = []; let user = null;
  for (const m of messages) {
    if (m?.role === 'user') { user = m.id != null ? String(m.id) : null; continue; }
    if (m?.role !== 'assistant' || !user || typeof m.content !== 'string') continue;
    const { react } = parseMedia(m.content);
    if (react && validEmoji(react)) out.push({ message: user, emoji: react, actor });
  }
  return out;
}
/** Stored reactions plus derived ones; an actor counts once per emoji on a message. */
export function mergeReactions(stored, derived) {
  const merged = Object.fromEntries(Object.entries(stored).map(([id, groups]) => [id, groups.map((g) => ({ emoji: g.emoji, actors: [...g.actors] }))]));
  for (const d of derived) {
    const groups = (merged[d.message] ??= []); let g = groups.find((x) => x.emoji === d.emoji);
    if (!g) { g = { emoji: d.emoji, actors: [] }; groups.push(g); }
    if (!g.actors.some((a) => a.id === d.actor.id)) g.actors.push(d.actor);
  }
  return merged;
}
```

Note: a user message without an id resets `user` to `null`, so a reply to a not-yet-stored message never lands on an older one.

- [ ] **Step 4: Wire the route in `server/index.js`**

Change the import on line 34 to `import { reactionStore, agentReactions, mergeReactions } from './reactions.js';`.

Replace the reactions block (currently starting `if (route === 'sessions' && parts.length === 6 && parts[5] === 'reactions') {`) with:

```js
        // Reactions and "delete for me" live beside each account's history. Never accept an actor identity from a request body.
        if (route === 'sessions' && parts.length === 6 && (parts[5] === 'reactions' || parts[5] === 'hidden')) {
          const sid = sessionId(parts[4]);
          let messages;
          try {
            messages = isChatKind(kindOf(m)) ? history.messages(m.name, sid, { limit: 1000 }).messages
              : kindOf(m) === 'mcp-inbox' ? inbox.messages(m.name, sid).messages
              : normalizeTranscript((await upstream.messages(m, sid)).messages);
          } catch (e) { if (e.status === 404) await ctx.reg.reactions.remove(m.name, sid); throw e; }
          current(m);
          const actor = { id: 'user:' + scopeOf(ctx), name: auth?.user?.username || 'You', kind: 'human' };
          if (req.method === 'PUT' || req.method === 'DELETE') {
            const b = await readJson(req, 2048);
            if (!messages.some(x => x.id != null && String(x.id) === b.message_id)) throw fault(404, 'Message not found');
            if (parts[5] === 'hidden') await ctx.reg.reactions.hide(m.name, sid, b.message_id, req.method === 'PUT');
            else await ctx.reg.reactions.set(m.name, sid, b.message_id, b.emoji, actor, req.method === 'PUT');
          } else if (req.method !== 'GET') throw fault(405, 'Method not allowed');
          const ids = new Set(messages.map(x => String(x.id)));
          const all = mergeReactions(ctx.reg.reactions.list(m.name, sid), agentReactions(messages, { id: 'agent:' + m.name, name: m.label || m.name, kind: 'agent' }));
          return sendJson(res, 200, { actor, messages: Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))), hidden: ctx.reg.reactions.hidden(m.name, sid).filter(id => ids.has(id)) });
        }
```

On line 230 change `agentReactions: kindOf(m) === 'mcp-inbox',` to:

```js
agentReactions: kindOf(m) === 'mcp-inbox' || kindOf(m) === 'hermes',
```

- [ ] **Step 5: Run the hub tests**

Run: `node --test server/test/reactions.test.js server/test/v04.test.js`
Expected: PASS. If any existing test asserted `agentReactions === false` for a Hermes agent (`grep -rn agentReactions server/test`), update it to `true` with a comment `// Hermes reacts through a REACT: line`.

- [ ] **Step 6: Document the contract**

Run once:

```bash
cd /e/Code/FoxFleet
node -e '
const fs = require("fs"), f = "contract/openapi.json", j = JSON.parse(fs.readFileSync(f, "utf8"));
const R = "/api/agents/{name}/sessions/{id}/reactions", H = "/api/agents/{name}/sessions/{id}/hidden";
const body = { required: true, content: { "application/json": { schema: { type: "object", required: ["message_id"], properties: { message_id: { type: "string" } }, additionalProperties: false } } } };
const ok = j.paths[R].put.responses["200"], notFound = j.paths[R].put.responses["404"];
j.paths[H] = {
  put: { operationId: "hideMessage", summary: "Delete for me: hide one message in this account (idempotent). The agent keeps it.", tags: ["agents"], requestBody: body, responses: { "200": ok, "404": notFound, "409": { description: "Hidden message limit reached", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } } },
  delete: { operationId: "unhideMessage", summary: "Show a hidden message again (idempotent).", tags: ["agents"], requestBody: body, responses: { "200": ok, "404": notFound } },
};
const S = j.components.schemas.Reactions;
S.properties.hidden = { type: "array", items: { type: "string" }, description: "Ids of messages this account hid (delete for me). Absent on hubs before 0.3.9." };
S.properties.messages.description = "Stable message id -> reactions on it, including reactions agents wrote as a REACT: line.";
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");'
git diff --stat contract/openapi.json
node --test server/test/contract.test.js
```

Expected: only insertions/changed lines around those entries; contract test PASS. If `JSON.stringify` reformatted the whole file, restore it and add the same objects by hand.

- [ ] **Step 7: Commit**

```bash
git add server/reactions.js server/index.js server/test/reactions.test.js contract/openapi.json
git commit -m "feat(hub): /hidden route, derived REACT: agent reactions, agentReactions for Hermes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Agent note line

**Files:**
- Modify: `connector/foxfleet-connector.mjs:452-461`
- Modify: `contract/agent-note.golden.txt`
- Test: `server/test/agent-note.test.js`

- [ ] **Step 1: Make the test require the line**

In the first test of `server/test/agent-note.test.js`, add `'REACT: ❤️'` to the `for (const must of [...])` list.

- [ ] **Step 2: Run and watch it fail**

Run: `node --test --test-name-pattern="golden text" server/test/agent-note.test.js`
Expected: FAIL (`REACT: ❤️` missing).

- [ ] **Step 3: Add the line**

In `agentNote`, insert after the `'Approvals and questions show as tap-to-answer cards: ask one question with short options.',` line:

```js
    "To react to the user's message, put REACT: ❤️ (any one emoji) on its own line. Use it sparingly.",
```

- [ ] **Step 4: Regenerate the golden file and re-run**

```bash
cd /e/Code/FoxFleet
UPDATE_GOLDEN=1 node --test --test-name-pattern="golden text" server/test/agent-note.test.js
node --test --test-name-pattern="golden text" server/test/agent-note.test.js
git diff contract/agent-note.golden.txt
```

Expected: PASS; the diff shows the new line and a new `foxfleet-note v<hash>`; the note stays under 800 characters (the test asserts it).

- [ ] **Step 5: Commit**

```bash
git add connector/foxfleet-connector.mjs contract/agent-note.golden.txt server/test/agent-note.test.js
git commit -m "feat(connector): agent note tells Hermes agents about REACT:

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Icons (reply, share, select all, edit)

**Files:**
- Modify: `design/icons/icons.json`
- Generated: `web/src/icons/paths.ts`, `android/app/src/main/java/dev/foxfleet/app/ui/FoxIcons.kt`

- [ ] **Step 1: Fetch the four paths from the pinned Material Symbols package and add them**

```bash
cd /e/Code/FoxFleet
node -e '
const fs = require("fs"), f = "design/icons/icons.json", j = JSON.parse(fs.readFileSync(f, "utf8"));
const want = { reply: "reply", share: "share", selectAll: "select_all", edit: "edit" };
(async () => {
  for (const [key, file] of Object.entries(want)) {
    const svg = await (await fetch(`https://unpkg.com/@material-symbols/svg-400@0.48.0/rounded/${file}.svg`)).text();
    const d = /<path d="([^"]+)"/.exec(svg)?.[1]; if (!d) throw new Error("no path for " + file);
    j.icons[key] = d;
  }
  fs.writeFileSync(f, JSON.stringify(j, null, 1) + "\n");
})();'
git diff --stat design/icons/icons.json
node design/tools/gen-icons.mjs
node design/tools/gen-icons.mjs --check
```

Expected: `icons.json` gains 4 entries (it uses 1-space JSON indentation; if the diff rewrites the whole file, restore and insert the four keys by hand); generator writes both files; `--check` exits 0.

- [ ] **Step 2: Run the icon tests**

Run: `cd web && npx vitest run tests/icons.test.ts` and `cd ../android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.ui.FoxIconsTest"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /e/Code/FoxFleet
git add design/icons/icons.json web/src/icons/paths.ts android/app/src/main/java/dev/foxfleet/app/ui/FoxIcons.kt
git commit -m "feat(design): reply, share, select-all and edit icons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web pure helpers (`messageActions.ts`)

**Files:**
- Create: `web/src/chat/messageActions.ts`
- Test: `web/tests/message-actions.test.tsx` (new)

- [ ] **Step 1: Write the failing tests**

Create `web/tests/message-actions.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { createDoubleTap, displayText, emptyReply, excerpt, messageActions, nextHeart, splitQuote, visibleMessages, withQuote } from '../src/chat/messageActions';
import type { UiMessage } from '../src/lib/chat';

const opts = { newestAssistant: false, newestUser: false, streaming: false, hermes: true, canShare: true, canHide: true, selectable: false };

describe('message actions', () => {
  it('a reply quote round-trips and only a leading "> line + blank line" counts', () => {
    const sent = withQuote({ author: 'Atlas', excerpt: 'Ship it?' }, 'Yes');
    expect(sent).toBe('> Ship it?\n\nYes');
    expect(splitQuote(sent)).toEqual({ quote: 'Ship it?', body: 'Yes' });
    expect(splitQuote('> no blank line\nYes')).toBeNull();
    expect(splitQuote('Yes\n> later')).toBeNull();
    expect(withQuote(null, 'Yes')).toBe('Yes');
  });

  it('display text drops tags, REACT: lines, file lines and the reply quote', () => {
    expect(displayText({ role: 'assistant', content: 'Done\nREACT: ❤️\nMEDIA:/tmp/a.png' })).toBe('Done');
    expect(displayText({ role: 'user', content: '> q\n\nHello\n\n[Attached file: uploads/a.txt (1 KB)]' })).toBe('Hello');
  });

  it('excerpt is one line, at most 140 characters, with a fallback for media-only messages', () => {
    expect(excerpt({ role: 'user', content: 'a\n\n b   c' })).toBe('a b c');
    const long = excerpt({ role: 'user', content: 'x'.repeat(200) });
    expect(Array.from(long).length).toBe(140); expect(long.endsWith('…')).toBe(true);
    expect(excerpt({ role: 'user', content: '', images: [{ dataUrl: 'data:image/png;base64,AA' }] })).toBe('[image]');
    expect(excerpt({ role: 'assistant', content: 'MEDIA:/tmp/v.ogg' })).toBe('[voice]');
    expect(excerpt({ role: 'assistant', content: 'MEDIA:/tmp/r.pdf' })).toBe('[file]');
  });

  it('a reply that is only a REACT: line draws no row; hidden ids are dropped', () => {
    const msgs: UiMessage[] = [{ id: 'u', role: 'user', content: 'hi' }, { id: 'a', role: 'assistant', content: 'REACT: ❤️' }, { id: 'b', role: 'assistant', content: 'Hello' }];
    expect(emptyReply(msgs[1])).toBe(true); expect(emptyReply(msgs[2])).toBe(false);
    expect(visibleMessages(msgs, new Set(['b'])).map((m) => m.id)).toEqual(['u']);
  });

  it('menu actions follow role, recency, agent kind and stable ids', () => {
    const a: UiMessage = { id: 'a', role: 'assistant', content: 'Hello' }, u: UiMessage = { id: 'u', role: 'user', content: 'Hi' };
    expect(messageActions(a, { ...opts, newestAssistant: true })).toEqual(['reply', 'copy', 'share', 'retry', 'delete']);
    expect(messageActions(a, { ...opts, newestAssistant: true, streaming: true })).toEqual(['reply', 'copy', 'share', 'delete']);
    expect(messageActions(u, { ...opts, newestUser: true })).toEqual(['reply', 'copy', 'share', 'edit', 'delete']);
    expect(messageActions(u, { ...opts, newestUser: true, hermes: false })).toEqual(['reply', 'copy', 'share', 'delete']);
    expect(messageActions({ role: 'user', content: 'Hi' }, { ...opts, canShare: false })).toEqual(['reply', 'copy']);
    expect(messageActions({ id: 'i', role: 'user', content: '', images: [{ dataUrl: 'x' }] }, opts)).toEqual(['reply', 'delete']);
  });

  it('double-tap toggles your heart', () => {
    const me = { id: 'user:u', name: 'Me', kind: 'human' as const };
    expect(nextHeart([], me.id)).toBe(true);
    expect(nextHeart([{ emoji: '❤️', actors: [me] }], me.id)).toBe(false);
    expect(nextHeart([{ emoji: '❤️', actors: [{ ...me, id: 'agent:a', kind: 'agent' }] }], me.id)).toBe(true);
  });

  it('a double tap is two taps within 300 ms and 24 px', () => {
    let now = 0; const tap = createDoubleTap(() => now);
    expect(tap(10, 10)).toBe(false); now = 200; expect(tap(20, 15)).toBe(true);
    now = 1000; expect(tap(10, 10)).toBe(false); now = 1400; expect(tap(10, 10)).toBe(false);
    now = 1500; expect(tap(100, 10)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && npx vitest run tests/message-actions.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `web/src/chat/messageActions.ts`**

```ts
import type { UiMessage } from '../lib/chat';
import { splitFiles } from '../lib/files';
import { parseMedia } from '../lib/mediaTags';
import type { ReactionGroup } from './Reactions';

/** Quick reactions, in menu order (the smiley-plus button opens the full picker). */
export const QUICK = ['👍', '👎', '❤️', '🎉', '😮'];
export const HEART = '❤️';
export interface ReplyTarget { author: string; excerpt: string }
export type MessageAction = 'reply' | 'copy' | 'select' | 'share' | 'retry' | 'edit' | 'delete';

const QUOTE = /^> ([^\n]*)\n\n/;
/** A reply's leading quote line, split from the rest; null when the text does not start with one. */
export function splitQuote(text: string): { quote: string; body: string } | null {
  const m = QUOTE.exec(text); return m ? { quote: m[1], body: text.slice(m[0].length) } : null;
}
/** The text a reply sends: the quoted excerpt on its own line, a blank line, then what the user wrote. */
export const withQuote = (reply: ReplyTarget | null | undefined, text: string) => (reply ? `> ${reply.excerpt}\n\n${text}` : text);

/** What a person sees of a message as plain text: tags, REACT: lines, file lines and a reply quote removed. */
export function displayText(m: UiMessage): string {
  if (m.role === 'assistant') return parseMedia(m.content).text;
  const { text } = splitFiles(m.content); return splitQuote(text)?.body ?? text;
}
/** One line, at most 140 characters, for the quote line of a reply. */
export function excerpt(m: UiMessage): string {
  const t = displayText(m).replace(/\s+/g, ' ').trim(), cp = Array.from(t);
  if (cp.length) return cp.length > 140 ? cp.slice(0, 139).join('') + '…' : t;
  const media = m.role === 'assistant' ? parseMedia(m.content).media : [];
  if (m.images?.length || media.some((x) => x.kind === 'image' || x.kind === 'video')) return '[image]';
  if (media.some((x) => x.kind === 'audio')) return '[voice]';
  return '[file]';
}
/** A finished reply that is only a REACT: line (or nothing) draws no row; its reaction shows on the user's message. */
export function emptyReply(m: UiMessage): boolean {
  if (m.role !== 'assistant' || m.reasoning || m.images?.length || m.error || m.interrupted) return false;
  const p = parseMedia(m.content); return !p.text.trim() && !p.media.length;
}
export const visibleMessages = (messages: UiMessage[], hidden: ReadonlySet<string>) => messages.filter((m) => !(m.id && hidden.has(m.id)) && !emptyReply(m));

/** Which actions a message offers, in menu order. Delete needs a hub id; Retry/Edit only on the newest message of that side. */
export function messageActions(m: UiMessage, o: { newestAssistant: boolean; newestUser: boolean; streaming: boolean; hermes: boolean; canShare: boolean; canHide: boolean; selectable: boolean }): MessageAction[] {
  const out: MessageAction[] = ['reply'];
  if (displayText(m).trim()) { out.push('copy'); if (o.selectable) out.push('select'); if (o.canShare) out.push('share'); }
  if (m.role === 'assistant' && o.newestAssistant && !o.streaming) out.push('retry');
  if (m.role === 'user' && o.newestUser && o.hermes && !o.streaming) out.push('edit');
  if (m.id && o.canHide) out.push('delete');
  return out;
}
/** Double-tap: add a heart, or take yours back. Returns the `present` value to send. */
export const nextHeart = (groups: ReactionGroup[], me: string) => !groups.some((g) => g.emoji === HEART && g.actors.some((a) => a.id === me));
/** Touch double-tap: two taps within 300 ms and 24 px (a third tap starts over). */
export function createDoubleTap(now: () => number = () => Date.now()) {
  let last: { t: number; x: number; y: number } | null = null;
  return (x: number, y: number) => {
    const t = now(), hit = !!last && t - last.t <= 300 && Math.hypot(x - last.x, y - last.y) <= 24;
    last = hit ? null : { t, x, y }; return hit;
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd web && npx vitest run tests/message-actions.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Code/FoxFleet
git add web/src/chat/messageActions.ts web/tests/message-actions.test.tsx
git commit -m "feat(web): message action helpers (quote, excerpt, visibility, menu, double tap)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web reactions: new quick row, hidden ids, hide()

**Files:**
- Modify: `web/src/chat/Reactions.tsx`, `web/src/api/client.ts:177-178`, `web/src/i18n/en.json`
- Test: `web/tests/reactions.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('reactions', ...)` in `web/tests/reactions.test.tsx` (add `applyHidden, QUICK` to the import from `'../src/chat/Reactions'`):

```tsx
  it('quick row is like, dislike, heart, confetti, surprise', () => {
    expect(QUICK).toEqual(['👍', '👎', '❤️', '🎉', '😮']);
  });

  it('hiding is optimistic and idempotent', () => {
    let s: ReactionSnapshot = { actor: me, messages: {}, hidden: [] };
    s = applyHidden(applyHidden(s, 'm', true), 'm', true); expect(s.hidden).toEqual(['m']);
    s = applyHidden(applyHidden(s, 'm', false), 'm', false); expect(s.hidden).toEqual([]);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && npx vitest run tests/reactions.test.tsx`
Expected: FAIL (`applyHidden` missing, QUICK differs).

- [ ] **Step 3: Implement**

In `web/src/chat/Reactions.tsx`:

```ts
/** The hub's answer for one conversation: who "you" are, the reactions on each stable message id, and what you hid. */
export interface ReactionSnapshot { actor: ReactionActor; messages: Record<string, ReactionGroup[]>; hidden?: string[] }
export { QUICK } from './messageActions';
```

Delete the old `export const QUICK = [...]` line; add `import { QUICK } from './messageActions';` at the top so `EmojiPicker` keeps using it.

After `applyReaction` add:

```ts
/** Optimistic "delete for me"; the hub's PUT/DELETE make the same change. */
export function applyHidden(s: ReactionSnapshot, message: string, present: boolean): ReactionSnapshot {
  const h = new Set(s.hidden ?? []); if (present) h.add(message); else h.delete(message);
  return { ...s, hidden: [...h] };
}
```

In `useReactions`, add after `react`:

```ts
  const hide = (message: string, present: boolean) => {
    if (!snap || !session) return;
    const before = snap, k = current; let failed = false;
    setSnap(applyHidden(snap, message, present)); setError(''); pending.current++;
    void client.hide(agent, session, message, present)
      .then((s) => { if (key.current === k && pending.current === 1) setSnap(s); })
      .catch(() => { failed = true; if (key.current === k) { setSnap(before); setError(t('msg.hideFailed')); } })
      .finally(() => { pending.current--; if (failed) refresh(); });
  };
  return { snap, error, react, hide, refresh };
```

(replace the existing `return { snap, error, react, refresh };`).

In `web/src/api/client.ts`, after the `react:` line add:

```ts
    hide: (agent: string, session: string, message: string, present: boolean) => request<import('../chat/Reactions').ReactionSnapshot>(`/api/agents/${enc(agent)}/sessions/${enc(session)}/hidden`, { method: present ? 'PUT' : 'DELETE', body: { message_id: message }, retries: 2 }), // idempotent, like reactions
```

In `web/src/i18n/en.json`, after `"react.list": "Reactions",` add:

```json
  "msg.actions": "Message actions",
  "msg.reply": "Reply",
  "msg.copy": "Copy",
  "msg.share": "Share",
  "msg.retry": "Retry",
  "msg.edit": "Edit",
  "msg.delete": "Delete for me",
  "msg.hidden": "Message hidden",
  "msg.undo": "Undo",
  "msg.hideFailed": "Couldn't hide the message. Try again.",
  "msg.replyingTo": "Replying to {name}",
  "msg.cancelReply": "Cancel reply",
  "msg.moreReactions": "More reactions",
  "msg.you": "You",
  "msg.react": "React {emoji}",
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run tests/reactions.test.tsx tests/client.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Code/FoxFleet
git add web/src/chat/Reactions.tsx web/src/api/client.ts web/src/i18n/en.json web/tests/reactions.test.tsx
git commit -m "feat(web): new quick reactions, hidden ids and hide() in the reactions hook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web message menu, gestures and reply bubble

**Files:**
- Create: `web/src/chat/MessageMenu.tsx`
- Modify: `web/src/chat/Message.tsx`, `web/src/styles/polish.css`
- Test: `web/tests/message-actions.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Append to `web/tests/message-actions.test.tsx` (new imports at the top: `render` from `'preact'`, `act` from `'preact/test-utils'`, `vi, beforeEach, afterEach` from `'vitest'`, `Message` from `'../src/chat/Message'`, `MessageMenu` from `'../src/chat/MessageMenu'`):

```tsx
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); vi.stubGlobal('fetch', vi.fn(async () => new Response('[]'))); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); vi.unstubAllGlobals(); });
const pointer = (type: string, pointerType: string, x = 10, y = 10) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerType, clientX: x, clientY: y });

describe('message gestures', () => {
  it('right-click opens the menu at the pointer; a touch double tap hearts; a mouse double click does not', async () => {
    const open = vi.fn(), heart = vi.fn();
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: 'Hello' }} onMedia={() => {}} gestures={{ open, heart }} />, host));
    const card = host.querySelector('.msg-card')!;
    await act(() => { card.dispatchEvent(Object.assign(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }))); });
    expect(open).toHaveBeenCalledWith(40, 50);
    await act(() => { card.dispatchEvent(pointer('pointerup', 'mouse')); card.dispatchEvent(pointer('pointerup', 'mouse')); });
    expect(heart).not.toHaveBeenCalled();
    await act(() => { card.dispatchEvent(pointer('pointerup', 'touch')); card.dispatchEvent(pointer('pointerup', 'touch')); });
    expect(heart).toHaveBeenCalledTimes(1);
  });

  it('the ⋯ button opens the same menu (keyboard reachable)', async () => {
    const open = vi.fn();
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: 'Hello' }} onMedia={() => {}} gestures={{ open, heart: () => {} }} />, host));
    await act(() => host.querySelector<HTMLButtonElement>('.msg-more')!.click());
    expect(open).toHaveBeenCalled();
  });

  it('a user message that starts with a quote shows a reply bubble above its text', async () => {
    await act(() => render(<Message m={{ role: 'user', content: '> Ship it?\n\nYes' }} onMedia={() => {}} />, host));
    expect(host.querySelector('.reply-quote')!.textContent).toBe('Ship it?');
    expect(host.querySelector('.user-text')!.textContent).toBe('Yes');
  });

  it('the menu offers the quick row, the picker and the actions', async () => {
    const onReact = vi.fn(), onAction = vi.fn(), onClose = vi.fn();
    await act(() => render(<MessageMenu x={10} y={10} actions={['reply', 'copy', 'delete']} canReact onReact={onReact} onAction={onAction} onClose={onClose} />, host));
    const quick = [...host.querySelectorAll<HTMLButtonElement>('.msg-menu-quick button')];
    expect(quick.length).toBe(6); // 5 emoji + more
    await act(() => quick[2].click()); expect(onReact).toHaveBeenCalledWith('❤️');
    const items = [...host.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
    expect(items.map((b) => b.textContent)).toEqual(['Reply', 'Copy', 'Delete for me']);
    await act(() => items[1].click()); expect(onAction).toHaveBeenCalledWith('copy');
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && npx vitest run tests/message-actions.test.tsx`
Expected: FAIL (`MessageMenu` missing; `gestures` prop unknown).

- [ ] **Step 3: Create `web/src/chat/MessageMenu.tsx`**

```tsx
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import type { IconName } from '../icons/paths';
import { t } from '../i18n/t';
import { Emoji, EmojiPicker } from './Reactions';
import { QUICK, type MessageAction } from './messageActions';

const LABEL: Record<MessageAction, Parameters<typeof t>[0]> = { reply: 'msg.reply', copy: 'msg.copy', select: 'msg.copy', share: 'msg.share', retry: 'msg.retry', edit: 'msg.edit', delete: 'msg.delete' };
const ICON: Record<MessageAction, IconName> = { reply: 'reply', copy: 'copy', select: 'selectAll', share: 'share', retry: 'retry', edit: 'edit', delete: 'delete' };

/** Long-press / right-click menu for one message: quick reactions on top, then the actions. Escape or an outside press closes it. */
export function MessageMenu({ x, y, actions, canReact, onReact, onAction, onClose }: {
  x: number; y: number; actions: MessageAction[]; canReact: boolean;
  onReact: (emoji: string) => void; onAction: (a: MessageAction) => void; onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null), [picking, setPicking] = useState(false);
  useLayoutEffect(() => {
    if (picking) return;
    box.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (e: Event) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [picking]);
  const left = Math.max(8, Math.min(x, (typeof innerWidth === 'number' ? innerWidth : 400) - 264)), top = Math.max(8, Math.min(y, (typeof innerHeight === 'number' ? innerHeight : 800) - 380));
  return (
    <div class="msg-menu" ref={box} style={{ left: `${left}px`, top: `${top}px` }} aria-label={t('msg.actions')}>
      {picking ? <EmojiPicker onPick={(e) => onReact(e)} onClose={onClose} /> : <>
        {canReact && <div class="msg-menu-quick">
          {QUICK.map((e) => <button type="button" key={e} aria-label={t('msg.react', { emoji: e })} onClick={() => onReact(e)}><Emoji value={e} size={24} /></button>)}
          <button type="button" class="more" aria-label={t('msg.moreReactions')} onClick={() => setPicking(true)}><Icon name="react" size={22} /></button>
        </div>}
        <div role="menu">
          {actions.map((a) => <button type="button" role="menuitem" key={a} class={a === 'delete' ? 'danger' : undefined} onClick={() => onAction(a)}><Icon name={ICON[a]} size={20} /><span>{t(LABEL[a])}</span></button>)}
        </div>
      </>}
    </div>
  );
}
```

`select` is never offered on web (Task 8 passes `selectable: false`), so its label entry only satisfies the type.

- [ ] **Step 4: Wire gestures and the reply bubble into `web/src/chat/Message.tsx`**

Add imports:

```tsx
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createDoubleTap, splitQuote } from './messageActions';
```

(this replaces the existing `preact/hooks` import line.)

Add above `export function Message`:

```tsx
/** How a message reacts to the hand: open the menu at a point, or toggle your heart. */
export interface MessageGestures { open: (x: number, y: number) => void; heart?: () => void }
const INTERACTIVE = 'a,button,img,video,audio,input,textarea,summary';

/** Right-click / long-press (touch, 500 ms) opens the menu; a touch double tap hearts. Taps on links, pictures and buttons stay theirs. */
function useGestures(g?: MessageGestures) {
  const [tap] = useState(() => createDoubleTap()), [pop, setPop] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | 0>(0);
  if (!g) return { handlers: {}, pop };
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = 0; };
  return {
    pop,
    handlers: {
      onContextMenu: (e: MouseEvent) => { e.preventDefault(); g.open(e.clientX, e.clientY); },
      onPointerDown: (e: PointerEvent) => { if (e.pointerType !== 'touch' || (e.target as HTMLElement).closest?.(INTERACTIVE)) return; const { clientX: x, clientY: y } = e; cancel(); timer.current = setTimeout(() => { timer.current = 0; g.open(x, y); }, 500); },
      onPointerMove: cancel, onPointerCancel: cancel,
      onPointerUp: (e: PointerEvent) => {
        cancel();
        if (e.pointerType !== 'touch' || !g.heart || (e.target as HTMLElement).closest?.(INTERACTIVE)) return;
        if (tap(e.clientX, e.clientY)) { g.heart(); setPop((n) => n + 1); }
      },
    },
  };
}
const HeartPop = ({ n }: { n: number }) => (n ? <span key={n} class="heart-pop" aria-hidden="true">❤️</span> : null);
const More = ({ g }: { g?: MessageGestures }) => (g ? <button type="button" class="msg-more react-add" aria-label={t('msg.actions')} title={t('msg.actions')} onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); g.open(r.left, r.bottom); }}><Icon name="more" size={18} /></button> : null);
```

Note: `onPointerMove: cancel` cancels the long press on any movement; jsdom never fires it in tests, and on phones a finger that stays still sends no move event. If real devices show jitter cancelling the press, track the start point and cancel only beyond 10 px.

Replace `AddReact` and change `Message`:

```tsx
const Actions = ({ r, g }: { r?: MessageReactions; g?: MessageGestures }) => (r || g ? <span class="msg-actions">{r && !r.groups.length && <ReactButton onPick={(e) => r.onReact(e, true)} />}<More g={g} /></span> : null);

export function Message({ m, onMedia, grouped = false, reactions, gestures }: { m: UiMessage; onMedia: (m: MediaItem) => void; grouped?: boolean; reactions?: MessageReactions; gestures?: MessageGestures }) {
  const { handlers, pop } = useGestures(m.role === 'system' ? undefined : gestures);
  if (m.role === 'system') return <div class="msg notice" role="status"><small class="muted">{m.content}</small></div>;
  if (m.role === 'user') {
    const { text, files } = splitFiles(m.content), q = splitQuote(text), body = q ? q.body : text;
    return (
      <div class={`msg user${grouped ? ' grouped' : ''}${reactions?.groups.length ? ' has-reacts' : ''}`}>
        <div class="msg-row">
          <Actions r={reactions} g={gestures} />
          <div class="bubble" {...handlers}>
            {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
            {q && <blockquote class="reply-quote">{q.quote}</blockquote>}
            {body && <p class="user-text">{body}</p>}
            <Time ts={m.ts} />
            {files.map((f, i) => <div class="chip" key={i}><Icon name="attach" size={16} /><span class="chip-name">{f.path.split('/').pop()}</span><small>{f.size}</small></div>)}
            <HeartPop n={pop} />
          </div>
        </div>
        <Reacts r={reactions} />
      </div>
    );
  }
  return (
    <div class={`msg assistant${m.error ? ' err' : ''}${grouped ? ' grouped' : ''}${reactions?.groups.length ? ' has-reacts' : ''}`}>
      {/* One frame per reply: reasoning, text, pictures and time belong to it, so it is clear what a reaction is on. */}
      <div class="msg-row">
        <div class="msg-card" {...handlers}>
          {m.reasoning && <Reasoning text={m.reasoning} ms={m.reasoningMs} />}
          {m.images?.length ? <div class="thumbs">{m.images.map((im, i) => <button key={i} class="thumb" aria-label={t('chat.openImage')} onClick={() => onMedia({ kind: 'image', src: im.dataUrl })}><img src={im.dataUrl} alt="" /></button>)}</div> : null}
          <AssistantText text={m.content} onMedia={onMedia} />
          {m.interrupted && <small class="interrupted muted">{t('chat.interrupted')}</small>}
          <Time ts={m.ts} />
          <HeartPop n={pop} />
        </div>
        <Actions r={reactions} g={gestures} />
      </div>
      <Reacts r={reactions} />
    </div>
  );
}
```

`useGestures` is called before the early return so the hook order never changes (`useRef` is already imported in `Message.tsx`).

The existing test `a message without a stable id offers no reaction control` still holds: without `reactions` there is no `.react-add` from ReactButton, and without `gestures` there is no `.msg-more`.

- [ ] **Step 5: Styles in `web/src/styles/polish.css`** (append)

```css
/* ---- message actions ---- */
.bubble, .msg-card { position: relative; -webkit-touch-callout: none; }
.msg-menu { position: fixed; z-index: 50; min-width: 240px; max-width: calc(100vw - 16px); padding: 8px; border: 1px solid var(--hairline); border-radius: 16px; background: var(--surface); box-shadow: 0 8px 28px rgb(0 0 0 / .18); }
.msg-menu-quick { display: flex; gap: 4px; justify-content: space-between; padding: 2px 2px 8px; border-bottom: 1px solid var(--hairline); margin-bottom: 4px; }
.msg-menu-quick button { display: grid; place-items: center; width: 40px; height: 40px; border: 0; border-radius: 50%; background: var(--surface-alt); cursor: pointer; color: var(--text-muted); }
.msg-menu-quick button:hover, .msg-menu-quick button:focus-visible { background: var(--hairline); }
.msg-menu [role=menuitem] { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 44px; padding: 0 12px; border: 0; border-radius: 10px; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.msg-menu [role=menuitem]:hover, .msg-menu [role=menuitem]:focus-visible { background: var(--surface-alt); }
.msg-menu [role=menuitem].danger { color: var(--danger); }
.reply-quote { margin: 2px 8px 4px; padding: 4px 8px; border-left: 3px solid var(--accent); border-radius: 6px; background: color-mix(in srgb, var(--surface-alt) 60%, transparent); color: var(--text-muted); font-size: .875rem; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.reply-chip { display: flex; align-items: center; gap: 8px; margin: 0 12px 6px; padding: 6px 8px; border-radius: 12px; background: var(--surface-alt); }
.reply-chip .reply-bar { align-self: stretch; width: 3px; border-radius: 2px; background: var(--accent); }
.reply-chip .reply-who { color: var(--accent); }
.reply-chip .reply-text { margin: 0; color: var(--text-muted); font-size: .875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hide-undo { text-align: center; }
.heart-pop { position: absolute; inset: 0; display: grid; place-items: center; font-size: 44px; pointer-events: none; animation: heart-pop 420ms ease-out forwards; }
@keyframes heart-pop { 0% { transform: scale(.4); opacity: 0; } 45% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .heart-pop { display: none; } }
:root[data-motion="reduce"] .heart-pop { display: none; }
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd web && npx vitest run tests/message-actions.test.tsx tests/reactions.test.tsx tests/media.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /e/Code/FoxFleet
git add web/src/chat/MessageMenu.tsx web/src/chat/Message.tsx web/src/styles/polish.css web/tests/message-actions.test.tsx
git commit -m "feat(web): message menu, right-click/long-press, touch double-tap heart, reply bubble

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Web chat wiring: actions, reply composer, edit, hide + undo

**Files:**
- Modify: `web/src/chat/ChatView.tsx`, `web/src/chat/Composer.tsx`, `web/src/chat/store.ts`
- Test: `web/tests/composer.test.tsx`

- [ ] **Step 1: Write the failing composer test**

Append to `web/tests/composer.test.tsx`:

```tsx
describe('reply', () => {
  it('a reply target shows a chip, sends the quote first, and clears after sending', async () => {
    const key = draftKey('atlas'), onClearReply = vi.fn();
    await act(() => render(<Composer key={key} draftKey={key} client={{ uploadFile } as unknown as Client} agent={agent('atlas')}
      history={[]} streaming={false} skills={[]} onSend={onSend} onStop={() => {}} onLocal={() => {}}
      reply={{ author: 'Atlas', excerpt: 'Ship it?' }} onClearReply={onClearReply} />, host));
    expect(host.querySelector('.reply-chip')!.textContent).toContain('Ship it?');
    await type('Yes');
    await act(() => host.querySelector<HTMLButtonElement>('button.send:not(.stop)')!.click());
    expect(onSend.mock.calls[0][0]).toBe('> Ship it?\n\nYes');
    expect(onClearReply).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd web && npx vitest run tests/composer.test.tsx`
Expected: FAIL (`reply` prop unknown / no `.reply-chip`).

- [ ] **Step 3: Composer**

In `web/src/chat/Composer.tsx`:

- Import: `import { withQuote, type ReplyTarget } from './messageActions';`
- Props type: add `reply?: ReplyTarget | null; onClearReply?: () => void;` to the props object.
- After the `useEffect` that resizes the textarea add: `useEffect(() => { if (props.reply) ta.current?.focus(); }, [props.reply]);`
- In `submit()`, replace the last line `props.onSend(out.text, out.imgs, out.refs, mode);` with:

```tsx
    props.onSend(withQuote(props.reply, out.text), out.imgs, out.refs, mode); props.onClearReply?.();
```

- In the JSX, directly before `{pending.length > 0 && (`, add:

```tsx
      {props.reply && <div class="reply-chip" role="status">
        <span class="reply-bar" aria-hidden="true" />
        <div class="grow"><small class="reply-who">{t('msg.replyingTo', { name: props.reply.author })}</small><p class="reply-text">{props.reply.excerpt}</p></div>
        <button type="button" class="icon-btn" aria-label={t('msg.cancelReply')} onClick={props.onClearReply}><Icon name="close" size={16} /></button>
      </div>}
```

- [ ] **Step 4: Store: `editLast`**

In `web/src/chat/store.ts`, after `retryLast` add:

```ts
/** Edit (Hermes): /undo takes the last exchange back from the agent, the history reloads, then the text goes back in the composer. */
export async function editLast(client: Client, agent: string, text: string, onAuthLost: () => void) {
  const c = chatOf(agent); if (c.streaming || c.loading || !c.session) return;
  await send(client, agent, '/undo', [], [], onAuthLost);
  const after = chatOf(agent); if (after.error) return;
  await restore(client, agent, after.session, onAuthLost, true);
  restoreDraft(draftKey(agent, after.session), text);
}
```

- [ ] **Step 5: ChatView**

In `web/src/chat/ChatView.tsx`:

Imports:

```tsx
import { MessageMenu } from './MessageMenu';
import { HEART, displayText, excerpt, messageActions, nextHeart, visibleMessages, type MessageAction, type ReplyTarget } from './messageActions';
import type { UiMessage } from '../lib/chat';
```

and add `editLast` to the import list from `'./store'`.

After the `const reactionsFor = ...` line add:

```tsx
  const [menu, setMenu] = useState<{ m: UiMessage; x: number; y: number } | null>(null), [reply, setReply] = useState<ReplyTarget | null>(null), [undo, setUndo] = useState<string | null>(null);
  useEffect(() => { setMenu(null); setReply(null); setUndo(null); }, [agent.name, c.session]);
  useEffect(() => { if (!undo) return; const id = setTimeout(() => setUndo(null), 5000); return () => clearTimeout(id); }, [undo]);
  const hidden = useMemo(() => new Set(reactions.snap?.hidden ?? []), [reactions.snap]);
  const shown = useMemo(() => visibleMessages(c.messages, hidden), [c.messages, hidden]);
  const newestA = [...c.messages].reverse().find((m) => m.role === 'assistant'), newestU = [...c.messages].reverse().find((m) => m.role === 'user');
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const actionsFor = (m: UiMessage) => messageActions(m, { newestAssistant: m === newestA, newestUser: m === newestU, streaming: c.streaming, hermes: agent.kind === 'hermes', canShare, canHide: Boolean(reactions.snap), selectable: false });
  const act = (m: UiMessage, a: MessageAction) => {
    setMenu(null);
    if (a === 'reply') setReply({ author: m.role === 'user' ? t('msg.you') : name, excerpt: excerpt(m) });
    else if (a === 'copy') void navigator.clipboard?.writeText(displayText(m));
    else if (a === 'share') void navigator.share?.({ text: displayText(m) }).catch(() => {});
    else if (a === 'retry') void retryLast(client, agent.name, onAuthLost);
    else if (a === 'edit') void editLast(client, agent.name, displayText(m), onAuthLost);
    else if (a === 'delete' && m.id) { reactions.hide(m.id, true); setUndo(m.id); }
  };
  const gesturesFor = (m: UiMessage) => {
    const r = reactionsFor(m.id);
    return { open: (x: number, y: number) => setMenu({ m, x, y }), heart: r && m.id ? () => r.onReact(HEART, nextHeart(r.groups, r.me)) : undefined };
  };
```

`name` is defined later in the current file (`const name = agent.displayName || agent.name;`); move that line above this block.

Replace the message list line:

```tsx
        {shown.map((m, i) => <Message key={m.id ?? i} m={m} onMedia={setViewer} grouped={shown[i - 1]?.role === m.role} reactions={reactionsFor(m.id)} gestures={gesturesFor(m)} />)}
        {undo && <p class="hide-undo muted small" role="status">{t('msg.hidden')} <button type="button" class="btn text" onClick={() => { reactions.hide(undo, false); setUndo(null); }}>{t('msg.undo')}</button></p>}
```

Right before `{viewer && <MediaViewer ...`, render the menu:

```tsx
      {menu && <MessageMenu x={menu.x} y={menu.y} actions={actionsFor(menu.m)} canReact={Boolean(menu.m.id && reactions.snap)}
        onReact={(e) => { const id = menu.m.id; setMenu(null); if (id) reactions.react(id, e, true); }} onAction={(a) => act(menu.m, a)} onClose={() => setMenu(null)} />}
```

Pass the reply into the composer: add `reply={reply} onClearReply={() => setReply(null)}` to the `<Composer ... />` props.

- [ ] **Step 6: Run the web suite, typecheck and build**

Run: `cd web && npm test && npm run build`
Expected: all tests PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /e/Code/FoxFleet
git add web/src/chat/ChatView.tsx web/src/chat/Composer.tsx web/src/chat/store.ts web/tests/composer.test.tsx
git commit -m "feat(web): reply, copy, share, retry, edit and delete-for-me wired into the chat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Android pure helpers (`MessageActions.kt`)

**Files:**
- Create: `android/app/src/main/java/dev/foxfleet/app/ui/chat/MessageActions.kt`
- Modify: `android/app/src/main/java/dev/foxfleet/app/ui/chat/Messenger.kt:45` (quick reactions)
- Test: `android/app/src/test/java/dev/foxfleet/app/ui/MessageActionsTest.kt` (new)

- [ ] **Step 1: Write the failing tests**

Create `MessageActionsTest.kt`:

```kotlin
package dev.foxfleet.app.ui

import dev.foxfleet.app.data.ImageAttachment
import dev.foxfleet.app.data.ReactionActor
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.UiMessage
import dev.foxfleet.app.ui.chat.MessageAction
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.QUICK_REACTIONS
import dev.foxfleet.app.ui.chat.ReplyTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same rules as web/tests/message-actions.test.tsx. */
class MessageActionsTest {
    @Test fun quickRowIsLikeDislikeHeartConfettiSurprise() = assertEquals(listOf("👍", "👎", "❤️", "🎉", "😮"), QUICK_REACTIONS)

    @Test fun quoteRoundTrips() {
        val sent = MessageActions.withQuote(ReplyTarget("Atlas", "Ship it?"), "Yes")
        assertEquals("> Ship it?\n\nYes", sent)
        assertEquals("Ship it?", MessageActions.splitQuote(sent)!!.quote)
        assertEquals("Yes", MessageActions.splitQuote(sent)!!.body)
        assertNull(MessageActions.splitQuote("> no blank line\nYes"))
        assertEquals("Yes", MessageActions.withQuote(null, "Yes"))
    }

    @Test fun displayTextDropsTagsReactFilesAndQuote() {
        assertEquals("Done", MessageActions.displayText(UiMessage("assistant", "Done\nREACT: ❤️\nMEDIA:/tmp/a.png")))
        assertEquals("Hello", MessageActions.displayText(UiMessage("user", "> q\n\nHello\n\n[Attached file: uploads/a.txt (1 KB)]")))
    }

    @Test fun excerptIsOneLineCappedWithFallbacks() {
        assertEquals("a b c", MessageActions.excerpt(UiMessage("user", "a\n\n b   c")))
        val long = MessageActions.excerpt(UiMessage("user", "x".repeat(200)))
        assertEquals(140, long.codePointCount(0, long.length)); assertTrue(long.endsWith("…"))
        assertEquals("[image]", MessageActions.excerpt(UiMessage("user", "", images = listOf(ImageAttachment("/p", "data:image/jpeg;base64,AA", 1)))))
        assertEquals("[voice]", MessageActions.excerpt(UiMessage("assistant", "MEDIA:/tmp/v.ogg")))
        assertEquals("[file]", MessageActions.excerpt(UiMessage("assistant", "MEDIA:/tmp/r.pdf")))
    }

    @Test fun reactOnlyRepliesAndHiddenIdsAreNotShown() {
        val msgs = listOf(UiMessage("user", "hi", id = "u"), UiMessage("assistant", "REACT: ❤️", id = "a"), UiMessage("assistant", "Hello", id = "b"))
        assertTrue(MessageActions.emptyReply(msgs[1])); assertFalse(MessageActions.emptyReply(msgs[2]))
        assertEquals(listOf("u"), MessageActions.visible(msgs, setOf("b")).map { it.value.id })
        assertEquals(listOf(0), MessageActions.visible(msgs, setOf("b")).map { it.index }) // original index kept for stable list keys
    }

    @Test fun menuActionsFollowRoleRecencyKindAndIds() {
        val a = UiMessage("assistant", "Hello", id = "a"); val u = UiMessage("user", "Hi", id = "u")
        assertEquals(listOf(MessageAction.Reply, MessageAction.Copy, MessageAction.Select, MessageAction.Share, MessageAction.Retry, MessageAction.Delete),
            MessageActions.actions(a, newestAssistant = true, newestUser = false, streaming = false, hermes = true, canHide = true))
        assertFalse(MessageAction.Retry in MessageActions.actions(a, newestAssistant = true, newestUser = false, streaming = true, hermes = true, canHide = true))
        assertTrue(MessageAction.Edit in MessageActions.actions(u, newestAssistant = false, newestUser = true, streaming = false, hermes = true, canHide = true))
        assertFalse(MessageAction.Edit in MessageActions.actions(u, newestAssistant = false, newestUser = true, streaming = false, hermes = false, canHide = true))
        assertEquals(listOf(MessageAction.Reply, MessageAction.Copy, MessageAction.Select, MessageAction.Share),
            MessageActions.actions(UiMessage("user", "Hi"), newestAssistant = false, newestUser = false, streaming = false, hermes = true, canHide = true))
    }

    @Test fun doubleTapTogglesYourHeart() {
        val me = ReactionActor("user:u", "Me", "human")
        assertTrue(MessageActions.nextHeart(emptyList(), me.id))
        assertFalse(MessageActions.nextHeart(listOf(ReactionGroup("❤️", listOf(me))), me.id))
        assertTrue(MessageActions.nextHeart(listOf(ReactionGroup("❤️", listOf(ReactionActor("agent:a", "A", "agent")))), me.id))
    }

    @Test fun swipeRules() {
        assertFalse(MessageActions.swipeAllowed(startXInWindow = 20f, edgePx = 24f))
        assertTrue(MessageActions.swipeAllowed(startXInWindow = 30f, edgePx = 24f))
        assertFalse(MessageActions.swipeFires(dragPx = 63f, thresholdPx = 64f))
        assertTrue(MessageActions.swipeFires(dragPx = 64f, thresholdPx = 64f))
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.ui.MessageActionsTest"`
Expected: compile failure (unresolved `MessageActions`).

- [ ] **Step 3: Implement**

In `Messenger.kt` replace the quick list:

```kotlin
/** Quick reactions, in menu order (the smiley-plus button opens the full picker). Same list as the web app. */
val QUICK_REACTIONS = listOf("👍", "👎", "❤️", "🎉", "😮")
```

Create `MessageActions.kt`:

```kotlin
package dev.foxfleet.app.ui.chat

import dev.foxfleet.app.data.FileMarker
import dev.foxfleet.app.data.ReactionGroup
import dev.foxfleet.app.data.UiMessage

const val HEART = "❤️"

/** Who wrote the quoted message and a one-line excerpt of it. */
data class ReplyTarget(val author: String, val excerpt: String)
data class Quoted(val quote: String, val body: String)

/** Menu entries, in menu order. */
enum class MessageAction(val label: String, val icon: String) {
    Reply("Reply", "reply"), Copy("Copy", "copy"), Select("Select text", "selectAll"), Share("Share", "share"),
    Retry("Retry", "retry"), Edit("Edit", "edit"), Delete("Delete for me", "delete"),
}

/** Message actions without UI: quotes, excerpts, what is shown, what the menu offers. Same rules as web/src/chat/messageActions.ts. */
object MessageActions {
    private val quote = Regex("^> ([^\\n]*)\\n\\n")

    fun splitQuote(text: String): Quoted? = quote.find(text)?.let { Quoted(it.groupValues[1], text.substring(it.range.last + 1)) }
    fun withQuote(reply: ReplyTarget?, text: String) = if (reply == null) text else "> ${reply.excerpt}\n\n$text"

    /** What a person sees of a message as plain text: tags, REACT: lines, file lines and a reply quote removed. */
    fun displayText(m: UiMessage): String =
        if (m.role == "assistant") MediaTags.parse(m.content).text else FileMarker.split(m.content).first.let { splitQuote(it)?.body ?: it }

    /** One line, at most 140 characters, for the quote line of a reply. */
    fun excerpt(m: UiMessage): String {
        val t = displayText(m).replace(Regex("\\s+"), " ").trim()
        if (t.isNotEmpty()) { val cps = t.codePoints().toArray(); return if (cps.size > 140) String(cps, 0, 139) + "…" else t }
        val media = if (m.role == "assistant") MediaTags.parse(m.content).media else emptyList()
        return when {
            m.images.isNotEmpty() || m.imageUrls.isNotEmpty() || media.any { it.kind == TagMedia.Kind.Image || it.kind == TagMedia.Kind.Video } -> "[image]"
            media.any { it.kind == TagMedia.Kind.Audio } -> "[voice]"
            else -> "[file]"
        }
    }

    /** A finished reply that is only a REACT: line (or nothing) draws no row; its reaction shows on the user's message. */
    fun emptyReply(m: UiMessage): Boolean {
        if (m.role != "assistant" || m.reasoning.isNotBlank() || m.imageUrls.isNotEmpty()) return false
        val p = MediaTags.parse(m.content); return p.text.isBlank() && p.media.isEmpty()
    }

    /** Messages to draw, with their index in the full list (list keys stay stable when one is hidden). */
    fun visible(messages: List<UiMessage>, hidden: Set<String>): List<IndexedValue<UiMessage>> =
        messages.withIndex().filter { (_, m) -> (m.id == null || m.id !in hidden) && !emptyReply(m) }

    fun actions(m: UiMessage, newestAssistant: Boolean, newestUser: Boolean, streaming: Boolean, hermes: Boolean, canHide: Boolean): List<MessageAction> = buildList {
        add(MessageAction.Reply)
        if (displayText(m).isNotBlank()) { add(MessageAction.Copy); add(MessageAction.Select); add(MessageAction.Share) }
        if (m.role == "assistant" && newestAssistant && !streaming) add(MessageAction.Retry)
        if (m.role == "user" && newestUser && hermes && !streaming) add(MessageAction.Edit)
        if (m.id != null && canHide) add(MessageAction.Delete)
    }

    /** Double-tap: add a heart, or take yours back. Returns the `present` value to send. */
    fun nextHeart(groups: List<ReactionGroup>, me: String) = groups.none { g -> g.emoji == HEART && g.actors.any { it.id == me } }

    /** A drag that starts within [edgePx] of the screen's left edge belongs to the system back gesture. */
    fun swipeAllowed(startXInWindow: Float, edgePx: Float) = startXInWindow > edgePx
    fun swipeFires(dragPx: Float, thresholdPx: Float) = dragPx >= thresholdPx
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.ui.MessageActionsTest" --tests "dev.foxfleet.app.ui.MessengerTest"`
Expected: PASS. If an existing test asserted the old 8-emoji list, update it to the new list.

- [ ] **Step 5: Commit**

```bash
cd /e/Code/FoxFleet
git add android/app/src/main/java/dev/foxfleet/app/ui/chat/MessageActions.kt android/app/src/main/java/dev/foxfleet/app/ui/chat/Messenger.kt android/app/src/test/java/dev/foxfleet/app/ui/MessageActionsTest.kt
git commit -m "feat(android): message action helpers and the new quick reactions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Android data: hidden ids, hide(), editLast

**Files:**
- Modify: `android/.../data/Models.kt:110`, `data/HubApi.kt:269-276` and `:609-620`, `ui/chat/ChatState.kt`, `HubViewModel.kt`
- Test: `android/app/src/test/java/dev/foxfleet/app/ui/MessengerTest.kt`

- [ ] **Step 1: Write the failing test**

Append to `MessengerTest`:

```kotlin
    @Test fun snapshotCarriesHiddenIds_andOldHubsHaveNone() {
        val withHidden = HubApi.parseReactions(Json.parseToJsonElement("""{"actor":{"id":"user:u","name":"U","kind":"human"},"messages":{},"hidden":["m1","m2"]}""").jsonObject)
        assertEquals(setOf("m1", "m2"), withHidden.hidden)
        val old = HubApi.parseReactions(Json.parseToJsonElement("""{"actor":{"id":"user:u","name":"U","kind":"human"},"messages":{}}""").jsonObject)
        assertTrue(old.hidden.isEmpty())
    }
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.ui.MessengerTest"`
Expected: compile failure (`hidden` unknown).

- [ ] **Step 3: Implement**

`Models.kt`:

```kotlin
/** The hub's reactions for one conversation: who "you" are, the reactions on each stable message id, and what you hid ("delete for me"). */
data class ReactionSnapshot(val actor: ReactionActor, val messages: Map<String, List<ReactionGroup>>, val hidden: Set<String> = emptySet())
```

`HubApi.parseReactions`: before `return`, add

```kotlin
            val hidden = runCatching { o["hidden"]?.jsonArray }.getOrNull().orEmpty().mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }.toSet()
```

and return `ReactionSnapshot(me, msgs, hidden)`.

`HubApi`, after `react(...)`:

```kotlin
    /** Delete for me: hide (or show again) one message for this sign-in. Idempotent; the agent keeps it. */
    suspend fun hide(agent: String, sessionId: String, messageId: String, present: Boolean): ReactionSnapshot = withContext(Dispatchers.IO) {
        parseReactions(request(agentPath(agent) + "/sessions/" + enc(sessionId) + "/hidden", if (present) "PUT" else "DELETE",
            buildJsonObject { put("message_id", messageId) }.toString()))
    }
```

`ChatState.kt`: next to `reactionError` add

```kotlin
    /** The message just hidden, while its Undo row shows (5 s). */
    var hiddenUndo by mutableStateOf<String?>(null)
```

Wherever `reactions = null; reactionError = null` appears (the two places around lines 122 and 142) also set `hiddenUndo = null`.

After `react(...)` add:

```kotlin
    /** Optimistic delete-for-me: hides at once, rolls back and re-reads the hub when the change fails. */
    suspend fun hide(api: HubApi, agent: String, messageId: String, present: Boolean) {
        val s = sessionId ?: return; val before = reactions ?: return
        reactions = before.copy(hidden = if (present) before.hidden + messageId else before.hidden - messageId); reactionError = null; reacting++
        hiddenUndo = if (present) messageId else null
        var failed = false
        try {
            val snap = api.hide(agent, s, messageId, present)
            if (s == sessionId && reacting == 1) reactions = snap
        } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { if (s == sessionId) reactions = before; throw e } catch (_: Exception) {
            failed = true; if (s == sessionId) { reactions = before; hiddenUndo = null; reactionError = "Couldn't hide the message. Try again." }
        } finally { reacting-- }
        if (failed) refreshReactions(api, agent)
    }
```

`HubViewModel.kt`, after `react(...)`:

```kotlin
    fun hide(agent: String, messageId: String, present: Boolean) {
        val state = chatFor(agent)
        viewModelScope.launch {
            try { state.hide(api, agent, messageId, present) }
            catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }

    /** Edit (Hermes): /undo takes the last exchange back from the agent, the history reloads, then [onUndone] puts the text in the composer. */
    fun editLast(agent: String, onUndone: () -> Unit) {
        val state = chatFor(agent); val sid = state.sessionId ?: return
        if (state.streaming || state.loading) return
        jobs[agent] = viewModelScope.launch {
            try {
                state.send(api, agent, "/undo", emptyList())
                if (state.error != null || state.sessionId != sid) return@launch
                val page = api.messages(agent, sid); if (state.sessionId == sid) state.load(page.messages, sid, page.hasMore)
                onUndone()
            } catch (e: CancellationException) { throw e } catch (e: AuthRequiredException) { deactivateMedia(purge = true); authed = false } catch (_: Exception) {}
        }
    }
```

Check `ChatState` exposes `error` (it does: the transcript reads `state.error`) and `load(messages, sessionId, hasMore)` (used by `openSession`).

- [ ] **Step 4: Run and watch it pass**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.ui.MessengerTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /e/Code/FoxFleet
git add android/app/src/main/java/dev/foxfleet/app/data/Models.kt android/app/src/main/java/dev/foxfleet/app/data/HubApi.kt android/app/src/main/java/dev/foxfleet/app/ui/chat/ChatState.kt android/app/src/main/java/dev/foxfleet/app/HubViewModel.kt android/app/src/test/java/dev/foxfleet/app/ui/MessengerTest.kt
git commit -m "feat(android): hidden ids in the reaction snapshot, hide() and editLast()

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Android menu sheet, select dialog, reply quote, heart pop, swipe wrapper

**Files:**
- Create: `android/app/src/main/java/dev/foxfleet/app/ui/components/MessageMenu.kt`
- Test: `android/app/src/test/java/dev/foxfleet/app/screenshots/MessengerScreenshotTest.kt`

- [ ] **Step 1: Write the screenshot test (fails to compile until the file exists)**

Add to `MessengerScreenshotTest`:

```kotlin
    private fun menu(dark: Boolean) {
        compose.setContent {
            FoxfleetTheme(AppPrefs(theme = if (dark) ThemeMode.Dark else ThemeMode.Light)) {
                androidx.compose.foundation.layout.Box(androidx.compose.ui.Modifier.background(dev.foxfleet.app.ui.LocalHubColors.current.surface)) {
                    dev.foxfleet.app.ui.components.MessageMenuContent(
                        actions = listOf(dev.foxfleet.app.ui.chat.MessageAction.Reply, dev.foxfleet.app.ui.chat.MessageAction.Copy, dev.foxfleet.app.ui.chat.MessageAction.Select,
                            dev.foxfleet.app.ui.chat.MessageAction.Share, dev.foxfleet.app.ui.chat.MessageAction.Retry, dev.foxfleet.app.ui.chat.MessageAction.Delete),
                        canReact = true, onReact = {}, onMoreReactions = {}, onAction = {},
                    )
                }
            }
        }
        compose.onRoot().captureRoboImage("$OUT/message-menu-${if (dark) "dark" else "light"}.png")
    }
    @Test fun menuLight() = menu(false)
    @Test fun menuDark() = menu(true)
```

Add `import androidx.compose.foundation.background` at the top.

- [ ] **Step 2: Create `MessageMenu.kt`**

```kotlin
package dev.foxfleet.app.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import dev.foxfleet.app.ui.FoxIcons
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.chat.HEART
import dev.foxfleet.app.ui.chat.MessageAction
import dev.foxfleet.app.ui.chat.MessageActions
import dev.foxfleet.app.ui.chat.QUICK_REACTIONS
import dev.foxfleet.app.ui.motion.reduceMotion
import dev.foxfleet.app.ui.motion.rememberHaptic
import kotlinx.coroutines.launch

/** Long-press sheet (Discord style): quick reactions, then the actions this message offers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageMenuSheet(actions: List<MessageAction>, canReact: Boolean, onReact: (String) -> Unit, onMoreReactions: () -> Unit, onAction: (MessageAction) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = LocalHubColors.current.surface) {
        MessageMenuContent(actions, canReact, onReact, onMoreReactions, onAction)
    }
}

/** The sheet's body, separate so screenshot tests can draw it without a window. */
@Composable
fun MessageMenuContent(actions: List<MessageAction>, canReact: Boolean, onReact: (String) -> Unit, onMoreReactions: () -> Unit, onAction: (MessageAction) -> Unit) {
    val c = LocalHubColors.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
        if (canReact) Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            QUICK_REACTIONS.forEach { e ->
                Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceAlt).semantics { contentDescription = "React $e" }.clickable(role = Role.Button) { onReact(e) }, contentAlignment = Alignment.Center) { EmojiGlyph(e, 28.dp) }
            }
            Box(Modifier.size(48.dp).clip(CircleShape).background(c.surfaceAlt).semantics { contentDescription = "More reactions" }.clickable(role = Role.Button, onClick = onMoreReactions), contentAlignment = Alignment.Center) {
                Icon(FoxIcons.get("react"), null, tint = c.textMuted, modifier = Modifier.size(24.dp))
            }
        }
        actions.forEach { a ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).clickable(role = Role.Button) { onAction(a) }.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(FoxIcons.get(a.icon), null, tint = c.text, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(16.dp))
                Text(a.label, style = MaterialTheme.typography.bodyLarge, color = c.text)
            }
        }
    }
}

/** "Select text": the message in a selectable, scrollable dialog. */
@Composable
fun SelectTextDialog(text: String, onDismiss: () -> Unit) {
    val c = LocalHubColors.current
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp).clip(RoundedCornerShape(16.dp)).background(c.surface).padding(16.dp)) {
            Text("Select text", style = MaterialTheme.typography.titleMedium, color = c.text)
            SelectionContainer(Modifier.padding(top = 8.dp).weight(1f, fill = false).verticalScroll(rememberScrollState())) { Text(text, style = MaterialTheme.typography.bodyLarge, color = c.text) }
            Text("Close", color = c.accent, modifier = Modifier.align(Alignment.End).padding(top = 8.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = onDismiss).padding(8.dp))
        }
    }
}

/** The quoted line of a reply, drawn as a bubble with an accent bar (Telegram style). */
@Composable
fun ReplyQuote(text: String, modifier: Modifier = Modifier, label: String? = null) {
    val c = LocalHubColors.current
    Row(modifier.height(IntrinsicSize.Min).clip(RoundedCornerShape(8.dp)).background(c.surfaceAlt.copy(alpha = 0.6f))) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(c.accent))
        Column(Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 4.dp)) {
            if (label != null) Text(label, style = MaterialTheme.typography.labelMedium, color = c.accent, maxLines = 1)
            Text(text, style = MaterialTheme.typography.bodySmall, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** The heart that pops over a message on double tap. Nothing when reduce-motion is on. */
@Composable
fun HeartPop(trigger: Int, modifier: Modifier = Modifier) {
    if (trigger == 0 || reduceMotion()) return
    val scale = remember(trigger) { Animatable(0.4f) }; val alpha = remember(trigger) { Animatable(1f) }
    LaunchedEffect(trigger) { scale.animateTo(1.15f, tween(220)); alpha.animateTo(0f, tween(200)) }
    Box(modifier.graphicsLayer { scaleX = scale.value; scaleY = scale.value; this.alpha = alpha.value }) { EmojiGlyph(HEART, 44.dp) }
}

/** Swipe a message right to reply: it follows the finger (max 96 dp), a reply arrow fades in, past 64 dp a tick, release past 64 dp replies. */
@Composable
fun SwipeToReply(onReply: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = LocalHubColors.current; val density = LocalDensity.current; val haptic = rememberHaptic(); val scope = rememberCoroutineScope()
    val reply by rememberUpdatedState(onReply)
    val offset = remember { Animatable(0f) }; var left by remember { mutableFloatStateOf(0f) }; var armed by remember { mutableStateOf(false) }
    val edge = with(density) { 24.dp.toPx() }; val threshold = with(density) { 64.dp.toPx() }; val cap = with(density) { 96.dp.toPx() }
    Box(modifier.onGloballyPositioned { left = it.positionInWindow().x }.pointerInput(Unit) {
        var active = false
        detectHorizontalDragGestures(
            onDragStart = { o -> active = MessageActions.swipeAllowed(left + o.x, edge); armed = false },
            onDragEnd = { if (active && MessageActions.swipeFires(offset.value, threshold)) reply(); active = false; scope.launch { offset.animateTo(0f, spring()) } },
            onDragCancel = { active = false; scope.launch { offset.animateTo(0f, spring()) } },
        ) { change, dx ->
            if (!active) return@detectHorizontalDragGestures
            change.consume()
            val next = (offset.value + dx).coerceIn(0f, cap)
            scope.launch { offset.snapTo(next) }
            val fires = MessageActions.swipeFires(next, threshold)
            if (fires && !armed) haptic(HapticFeedbackType.LongPress)
            armed = fires
        }
    }) {
        Icon(FoxIcons.get("reply"), null, tint = c.textMuted, modifier = Modifier.align(Alignment.CenterStart).padding(start = 4.dp).size(22.dp)
            .graphicsLayer { alpha = (offset.value / threshold).coerceIn(0f, 1f) })
        Box(Modifier.graphicsLayer { translationX = offset.value }) { content() }
    }
}
```

`rememberHaptic` and `reduceMotion` live in `ui/motion/Motion.kt`; if `reduceMotion` is in another file (`ChatScreen` imports it as `dev.foxfleet.app.ui.motion.reduceMotion`), keep that import path.

- [ ] **Step 3: Run the screenshot test and look at the images**

Run: `cd android && ./gradlew :app:testDebugUnitTest --tests "dev.foxfleet.app.screenshots.MessengerScreenshotTest"`
Expected: PASS; open `android/app/build/outputs/roborazzi/message-menu-light.png` and `-dark.png` and check: 5 emoji + smiley-plus in one row, six labelled rows with icons, readable in both themes.

- [ ] **Step 4: Commit**

```bash
cd /e/Code/FoxFleet
git add android/app/src/main/java/dev/foxfleet/app/ui/components/MessageMenu.kt android/app/src/test/java/dev/foxfleet/app/screenshots/MessengerScreenshotTest.kt
git commit -m "feat(android): message menu sheet, select dialog, reply quote, heart pop, swipe-to-reply wrapper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Android chat wiring

**Files:**
- Modify: `android/app/src/main/java/dev/foxfleet/app/ui/screens/ChatScreen.kt`, `android/app/src/main/java/dev/foxfleet/app/MainActivity.kt:165-185`
- Test: `android/app/src/test/java/dev/foxfleet/app/screenshots/MessengerScreenshotTest.kt` (existing frames test must still pass), full unit suite

- [ ] **Step 1: ChatScreen parameters and state**

Add parameters to `ChatScreen` (after `onReact`):

```kotlin
    /** Delete for me (hub hidden list); null hides the action. */
    onHide: ((messageId: String, present: Boolean) -> Unit)? = null,
    /** Edit (Hermes only): run /undo, then call the given function to put the text back. */
    onEditLast: ((onUndone: () -> Unit) -> Unit)? = null,
```

Inside `ChatScreen`, next to `reactingTo`:

```kotlin
    var menuFor by remember { mutableStateOf<UiMessage?>(null) }
    var selecting by remember { mutableStateOf<String?>(null) }
    var reply by remember(state.sessionId) { mutableStateOf<ReplyTarget?>(null) }
    var prefill by remember { mutableStateOf<String?>(null) }
    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
    val ctx = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(state.hiddenUndo) { if (state.hiddenUndo != null) { withContext(Dispatchers.Default) { delay(5_000) }; state.hiddenUndo = null } }
    fun act(m: UiMessage, a: MessageAction) {
        menuFor = null
        when (a) {
            MessageAction.Reply -> reply = ReplyTarget(if (m.role == "user") "You" else agent.label ?: agent.name, MessageActions.excerpt(m))
            MessageAction.Copy -> clipboard.setText(androidx.compose.ui.text.AnnotatedString(MessageActions.displayText(m)))
            MessageAction.Select -> selecting = MessageActions.displayText(m)
            MessageAction.Share -> ctx.startActivity(android.content.Intent.createChooser(
                android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain").putExtra(android.content.Intent.EXTRA_TEXT, MessageActions.displayText(m)), null))
            MessageAction.Retry -> onRetry()
            MessageAction.Edit -> onEditLast?.invoke { prefill = MessageActions.displayText(m) }
            MessageAction.Delete -> m.id?.let { id -> onHide?.invoke(id, true) }
        }
    }
    val gestures = MessageGestures(
        onMenu = { menuFor = it },
        onHeart = { id -> state.reactions?.let { s -> onReact(id, HEART, MessageActions.nextHeart(s.messages[id].orEmpty(), s.actor.id)) } },
        onReply = { m -> reply = ReplyTarget(if (m.role == "user") "You" else agent.label ?: agent.name, MessageActions.excerpt(m)) },
        onUndoHide = { id -> onHide?.invoke(id, false) },
    )
```

Imports to add at the top of `ChatScreen.kt`: `dev.foxfleet.app.ui.chat.HEART`, `dev.foxfleet.app.ui.chat.MessageAction`, `dev.foxfleet.app.ui.chat.MessageActions`, `dev.foxfleet.app.ui.chat.ReplyTarget`, `dev.foxfleet.app.ui.components.HeartPop`, `dev.foxfleet.app.ui.components.MessageMenuSheet`, `dev.foxfleet.app.ui.components.ReplyQuote`, `dev.foxfleet.app.ui.components.SelectTextDialog`, `dev.foxfleet.app.ui.components.SwipeToReply`, and `androidx.compose.runtime.mutableIntStateOf`.

Add next to `MessageReactions` at the bottom of the file:

```kotlin
/** What a message row does with the hand: long press opens the menu, double tap hearts, swipe right replies. */
private class MessageGestures(val onMenu: (UiMessage) -> Unit, val onHeart: (String) -> Unit, val onReply: (UiMessage) -> Unit, val onUndoHide: (String) -> Unit)
```

- [ ] **Step 2: Sheets and dialog**

Replace the `reactingTo?.let { ... }` line with:

```kotlin
    menuFor?.let { m ->
        val newestA = state.messages.lastOrNull { it.role == "assistant" }; val newestU = state.messages.lastOrNull { it.role == "user" }
        MessageMenuSheet(
            actions = MessageActions.actions(m, newestAssistant = m === newestA, newestUser = m === newestU, streaming = state.streaming, hermes = agent.isHermes && onEditLast != null, canHide = onHide != null && state.reactions != null),
            canReact = m.id != null && state.reactions != null,
            onReact = { e -> menuFor = null; m.id?.let { onReact(it, e, true) } },
            onMoreReactions = { menuFor = null; reactingTo = m.id },
            onAction = { act(m, it) }, onDismiss = { menuFor = null },
        )
    }
    reactingTo?.let { id -> dev.foxfleet.app.ui.components.EmojiPickerSheet(onPick = { e -> reactingTo = null; onReact(id, e, true) }, onDismiss = { reactingTo = null }) }
    selecting?.let { SelectTextDialog(it) { selecting = null } }
```

- [ ] **Step 3: Transcript: filter, keys, undo row, gestures**

Change the `Transcript` signature: replace `onPickReaction: (String) -> Unit = {},` with `onPickReaction: (String) -> Unit = {}, gestures: MessageGestures? = null,` and pass `gestures = gestures` from `ChatScreen`'s `Transcript(...)` call.

After the `state.reactionError?.let { ... }` item add:

```kotlin
        state.hiddenUndo?.let { id -> item(key = "hide-undo") {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                Text("Message hidden", style = MaterialTheme.typography.bodySmall, color = c.textMuted)
                Text("Undo", style = MaterialTheme.typography.labelLarge, color = c.accent, modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { gestures?.onUndoHide?.invoke(id) }.padding(10.dp))
            }
        } }
```

Replace the message `items(...)` block with:

```kotlin
        val rev = MessageActions.visible(state.messages, state.reactions?.hidden.orEmpty()).asReversed()
        items(rev.size, key = { state.keyBase + rev[it].index }) { i ->
            // only messages that arrive after the history has been shown animate in (never old ones scrolled back into view)
            val (index, m) = rev[i]; val b = baseline; val isNew = b != null && state.keyBase + index >= b
            val snap = state.reactions; val id = m.id
            val reactions = if (id != null && snap != null) MessageReactions(snap.messages[id].orEmpty(), snap.actor.id, { e, on -> onReact(id, e, on) }, { onPickReaction(id) }) else null
            val row: @Composable () -> Unit = { MessageRow(agentName, m, Modifier.animateItem().messageEnter(isNew), onOpen, state.sessionId.orEmpty(), reactions, gestures) }
            if (gestures != null) SwipeToReply({ gestures.onReply(m) }) { row() } else row()
        }
```

Note `Modifier.animateItem()` must stay on the item's root; if Compose complains that `animateItem` is not on the direct child, move `Modifier.animateItem().messageEnter(isNew)` to `SwipeToReply(..., modifier = Modifier.animateItem().messageEnter(isNew))` and pass `Modifier` to `MessageRow`.

- [ ] **Step 4: MessageRow: long press menu, double tap heart, reply bubble**

Change the `MessageRow` signature to add `gestures: MessageGestures? = null` as the last parameter. Replace the `reactable` definition with:

```kotlin
    var pop by remember { mutableIntStateOf(0) }
    val heart: (() -> Unit)? = if (gestures != null && reactions != null && m.id != null) ({ haptic(HapticFeedbackType.LongPress); gestures.onHeart(m.id); pop++ }) else null
    val reactable = if (gestures == null) Modifier else Modifier
        .combinedClickable(interactionSource = press, indication = null, onClick = {}, onDoubleClick = heart,
            onLongClick = { haptic(HapticFeedbackType.LongPress); gestures.onMenu(m) }, onLongClickLabel = "Message actions")
        .semantics { customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction("Message actions") { gestures.onMenu(m); true }) }
```

In the user branch, replace the body-text line with:

```kotlin
                val quoted = remember(bodyText) { MessageActions.splitQuote(bodyText) }
                if (quoted != null) ReplyQuote(quoted.quote, Modifier.align(Alignment.Start).padding(horizontal = 8.dp, vertical = 4.dp))
                val shownText = quoted?.body ?: bodyText
                if (shownText.isNotBlank()) Text(shownText, style = MaterialTheme.typography.bodyLarge, color = c.text, modifier = Modifier.align(Alignment.Start).padding(horizontal = 8.dp, vertical = 4.dp))
```

Show the heart pop over each frame: wrap the user frame `Column(...)` and the assistant frame `Column(...)` each in `Box(contentAlignment = Alignment.Center) { <existing frame Column>; HeartPop(pop) }`. The pills stay outside the Box, as today.

- [ ] **Step 5: Composer: reply chip, quote on send, prefill**

Add parameters to the private `Composer`:

```kotlin
    reply: ReplyTarget? = null,
    onClearReply: () -> Unit = {},
    prefill: String? = null,
    onPrefilled: () -> Unit = {},
```

After `var input by rememberSaveable { ... }` add:

```kotlin
    LaunchedEffect(prefill) { prefill?.let { if (input.isBlank()) input = it; onPrefilled() } }
```

In the plain-send path replace

```kotlin
        val t = FileMarker.compose(input.trim(), files); val imgs = attachments
```

with

```kotlin
        val t = MessageActions.withQuote(reply, FileMarker.compose(input.trim(), files)); val imgs = attachments
```

and after `haptic(HapticFeedbackType.Confirm); onSend(t, imgs, mode)` add `; onClearReply()`.

In the Composer's outer `Column(Modifier.fillMaxWidth()) {`, directly after the `if (browser) Dialog(...) { ... }` block, add:

```kotlin
        if (reply != null) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            ReplyQuote(reply.excerpt, Modifier.weight(1f), label = "Replying to ${reply.author}")
            SoftIconButton(FoxIcons.get("close"), "Cancel reply", onClearReply)
        }
```

Pass the new arguments from `ChatScreen`'s `Composer(...)` call: `reply = reply, onClearReply = { reply = null }, prefill = prefill, onPrefilled = { prefill = null },`.

- [ ] **Step 6: MainActivity**

In the `ChatScreen(` call add:

```kotlin
                onHide = if (agent.capabilities.reactions) ({ id, present -> vm.hide(agent.name, id, present) }) else null,
                onEditLast = if (agent.isHermes) ({ done -> vm.editLast(agent.name, done) }) else null,
```

- [ ] **Step 7: Build and run the whole unit suite**

Run: `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`
Expected: BUILD SUCCESSFUL; all tests pass. Open `build/outputs/roborazzi/messenger-frames-light.png`: frames look unchanged (no gesture UI is visible at rest).

- [ ] **Step 8: Commit**

```bash
cd /e/Code/FoxFleet
git add android/app/src/main/java/dev/foxfleet/app/ui/screens/ChatScreen.kt android/app/src/main/java/dev/foxfleet/app/MainActivity.kt
git commit -m "feat(android): long-press menu, double-tap heart, swipe to reply, quote replies, delete for me, edit last

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Release notes, version 0.3.9-alpha, full verification

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `server/package.json`, `contract/openapi.json` (`info.version`), `connector/foxfleet-connector.mjs:21`, `android/app/build.gradle.kts` (`versionName`, `versionCode`), `scripts/hub-tests.min`, `web/package.json` if it carries a version

- [ ] **Step 1: Bump versions**

```bash
cd /e/Code/FoxFleet
grep -rln "0\.3\.8-alpha" package.json server/package.json web/package.json contract/openapi.json connector/foxfleet-connector.mjs android/app/build.gradle.kts
```

In each file listed, change `0.3.8-alpha` to `0.3.9-alpha`. In `android/app/build.gradle.kts` also change `versionCode = 16` to `versionCode = 17`.

- [ ] **Step 2: CHANGELOG**

Add at the top of `CHANGELOG.md`, in the existing entry format (copy the heading style of the 0.3.8-alpha entry):

```markdown
## 0.3.9-alpha

- *Messages:* long-press (Android) or right-click / long-press / ⋯ (web) opens a menu: quick reactions 👍 👎 ❤️ 🎉 😮 plus the full picker, Reply, Copy, Select text (Android), Share, Retry (newest reply), Edit (your newest message, Hermes: runs /undo and puts the text back), Delete for me.
- *Messages:* double-tap a message to heart it (touch only on web); swipe a message right to reply (Android).
- *Replies:* a reply starts with a `> quote` line; both apps draw it as a reply bubble.
- *Hub:* `PUT/DELETE /api/agents/{name}/sessions/{id}/hidden` keeps a per-account hidden list (the agent keeps the message); the reactions snapshot gains `hidden`.
- *Agents:* Hermes agents react by writing `REACT: <emoji>` on its own line; the hub shows it as the agent's reaction on your message, and the line is never shown. `agentReactions` is now true for Hermes. The agent note gains one line (connector 0.3.9-alpha).
```

- [ ] **Step 3: Raise the hub test floor**

Run: `npm test`
Read the `hub tests: N ran` line. Set `scripts/hub-tests.min` to that `N` (it should be the old 290 plus the 6 new hub tests, minus nothing). Run `npm test` again; expected: PASS. Test files that fail identically on `main` on Windows (see Conventions) are not regressions; confirm with `git stash; npm test; git stash pop` only if unsure.

- [ ] **Step 4: Run every other gate**

```bash
cd /e/Code/FoxFleet/web && npm test && npm run build
cd /e/Code/FoxFleet/android && ./gradlew :app:testDebugUnitTest :app:assembleDebug
cd /e/Code/FoxFleet && node design/tools/gen-icons.mjs --check && npm --prefix web run tokens:check
```

Expected: all PASS / BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md package.json server/package.json web/package.json contract/openapi.json connector/foxfleet-connector.mjs android/app/build.gradle.kts scripts/hub-tests.min
git commit -m "[0.3.9-alpha] message actions: menu, double-tap heart, swipe reply, quote replies, delete for me, Hermes REACT:

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Record what still needs a device or a live agent**

Append to the spec's end a `## Verification status` section listing, as pending unless actually done: long-press / double-tap / swipe on a physical phone, swipe vs. system back gesture, TalkBack "Message actions", a live Hermes agent writing `REACT:`, two clients seeing the same hide, iOS Safari long-press on web. Commit it with the message `docs: message actions verification status`.
