# Accessibility checklist (web app)

Target: WCAG 2.2 AA. Items are checked by automated tests where possible (`web/tests/a11y.test.ts`, `sw.test.ts`) and by the manual pass below.
Re-run the manual pass for any change to layout, colour tokens or interaction.

## Automated
- [x] Colour contrast of every text/background pair in the shared tokens, light and dark, for every accent (≥ 4.5:1 text, ≥ 7:1 body). Light accents Ember/Ocean/Moss were darkened to pass; the same tokens feed the Android theme.
- [ ] axe-core run in CI against the mock hub (not yet wired).

## Structure and focus
- [x] One `h1` per view; landmarks: `header`/`aside nav`/`main`. Two named `nav` regions (agents; account and tools).
- [x] "Skip to content" link is the first tab stop and moves focus to `main`.
- [x] Route changes move focus to `main` (programmatic, `tabindex=-1`), so keyboard and screen-reader users start at the new view.
- [x] Phone drawer: menu button has `aria-expanded` / `aria-controls`; Escape closes it; the closed drawer is `visibility:hidden` so it is not in the tab order.
- [x] Visible focus ring (3 px accent, 2 px offset) on everything focusable; `forced-colors` outlines for selected chips and swatches.
- [x] Message list is a focusable `role=log` region (scrollable with the keyboard).
- [x] Composer has a visible `focus-within` outline. Sessions moves focus into the menu, supports arrow keys/Home/End, closes on Escape/Tab/outside interaction, and returns focus after Escape or selection.

## Labels and semantics
- [x] Every input has a `<label>`; hints use `aria-describedby`; errors use `role=alert`.
- [x] Icon-only buttons have `aria-label` (menu, attach, remove, send, stop, zoom, close, copy).
- [x] Choice groups (connection type, registration mode, theme, accent, text size, motion) are `role=radiogroup` with `role=radio` + `aria-checked`; accent swatches are named.
- [x] Current page is marked with `aria-current="page"` in the navigation.
- [x] Command autocomplete is a `listbox` of `option`s with `aria-selected`; ↑/↓, Tab/Enter to accept, Esc to dismiss.
- [x] Keys row on the screen view is a `toolbar`; the remote screen has a label.

## Streaming and live regions
- [x] Replies are **not** announced token by token (`aria-live="off"` on the log). A single polite status announces "{agent} is replying", and one more when the reply has finished (first 300 characters).
- [x] The shimmer status line is `role=status`; the shimmer animation stops under `prefers-reduced-motion` and when Settings › Motion › Reduce is on.
- [x] Screen takeover: connection state and the hand-back countdown are in a polite live region.

## Keyboard
- [x] Everything is reachable and operable without a pointer: add/edit/reorder agents (↑/↓ buttons, not drag-only), attach menu, media viewer (Esc close, +/−/0 zoom), invites, devices.
- [ ] Remote-screen keyboard capture while in control: noVNC grabs keys when the canvas is focused; verify with a screen reader before release.

## Drafts
- [x] Unsent message text is remembered per chat (web): restored after navigating, reloading or reopening the browser, so interrupted keyboard or voice entry is not lost. It is stored locally per signed-in user and removed on sign-out.

## Visual and motion
- [x] Text size setting (small / default / large) scales typography rather than the whole body; the shell tracks the viewport and chat messages scroll independently. Browser zoom up to 200% keeps the layout usable (single column on phones).
- [x] Status is never colour-only (online dot has an accessible name; checks say OK/Failed).
- [x] Minimum touch target ≈ 36–40 px for icon buttons and chips.
- [ ] Manual screen-reader pass (NVDA + Firefox, VoiceOver + Safari, TalkBack + Chrome) for sign-in, chat, add agent. Not yet done.
