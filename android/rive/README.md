# Rive assets

`thinking_dots/` is a 3-dot pulsing "thinking" indicator authored headlessly with the
Rive CLI 1.5.1 (`~/.rive/bin/rive`): `rive thinking_dots --verify`, `rive thinking_dots --once`
(unsigned local build, no scripts), `--screenshot --advance=300ms` -> preview.png. Our own work, no third-party licence.

It is NOT bundled in the APK yet: it hasn't been tried on a device with rive-android 11.14.0.
To turn it on, copy `thinking_dots/thinking_dots.riv` to `app/src/main/res/raw/foxfleet_loader.riv`.
`ui/components/RiveAvatar.kt` picks up that raw resource automatically and otherwise falls back
to the Compose breathing avatar. The Rive Editor itself has no native Linux build (macOS/Windows plus
the web editor, which needs a signed-in browser); the CLI covers authoring here.
