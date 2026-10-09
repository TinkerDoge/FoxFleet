# Accessibility checklist (web app)

Target: WCAG 2.2 AA. Items are checked by automated tests where possible (`web/tests/a11y.test.ts`, `sw.test.ts`) and by the manual pass below.
Re-run the manual pass for any change to layout, colour tokens or interaction.

## Automated
- [x] Automated shared-token coverage: body ≥ 7:1 and muted/faint text ≥ 4.5:1 on `bg`, `surface`, and `surfaceAlt` in both themes; danger text on background/surface; every accent as link text and body text on user bubbles. Status dots retain their component contrast; separate Online/Ready text and idle text pass ≥ 4.5:1 on plain surfaces and 12% status tints. Offline pills use muted text on their 12% offline tint. Generated tokens feed both clients.
- [ ] Audit all rendered text/background combinations beyond these tested pairs. Token tests alone do not establish accessibility of the whole application.
- [ ] axe-core run in CI against the mock hub (not yet wired).

## Structure and focus
- [x] Ordinary chat has an `h1` naming its agent, with controlled visual ellipsis. Landmarks include `header`/`aside nav`/`main`; two named navigation regions (agents; account and tools).
- [ ] Complete the heading/landmark review across all views with a screen reader.
- [x] "Skip to content" link is the first tab stop and moves focus to `main`.
- [x] Route, agent, session and explicit New-chat changes move focus to `main` (`tabindex=-1`). Regression tests cover same-agent session changes; human screen-reader validation remains pending.
- [x] Phone drawer: modal dialog semantics while open, focus enters and stays inside, background content is inert, Escape/scrim/Close dismiss it and restore the menu trigger. The closed drawer is inert and hidden. Resizing to desktop releases the modal background. Covered by automated keyboard checks.
- [x] Visible focus ring (3 px accent, 2 px offset) on everything focusable; `forced-colors` outlines for selected chips and swatches.
- [x] Message list is a focusable `role=log` region (scrollable with the keyboard).
- [x] Composer has a visible `focus-within` outline. History, Attach and compact chat-action menus support arrow keys/Home/End, Escape/Tab/outside dismissal and focus restoration after Escape or selection. Attachment actions close the menu before opening the picker; canceled pickers leave a usable trigger.

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
- [x] Text size setting (small / default / large) scales typography rather than the whole body; the shell tracks the viewport and chat messages scroll independently. Compact chat actions and bounded agent identity protect narrow headers.
- [ ] Repeat real-device keyboard, landscape, system-font and 200% browser-zoom checks after the header/menu changes.
- [x] Status is never colour-only (online dot has an accessible name; checks say OK/Failed).
- [x] Frequent mobile-web chat controls (Attach, Send, Stop, History, overflow and drawer Close) have 44px minimum targets. Other controls retain their existing sizes; this is not a blanket target-size conformance claim.
- [ ] Manual screen-reader pass (NVDA + Firefox, VoiceOver + Safari, TalkBack + Chrome) for sign-in, chat, add agent. Not yet done.
- [ ] Physical Android contrast, large-font, rotation, keyboard and TalkBack validation after the shared status-pill colour changes.
