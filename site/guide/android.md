# Install the Android app

The app is `dev.foxfleet.app` (name **FoxFleet**), minimum Android 10 (API 29), built with Kotlin and Jetpack Compose.

::: warning Status: not verified on a physical device
Unit tests and screenshot tests (Roborazzi) pass in development and the APK assembles, but the maintainers have not yet run the current build end to end on a physical device. Release builds are signed with the project's own key (certificate SHA-256 `df97dd3d75119537bce17a868bba08c8b5675c54c01a16a2f6b0fe5d528252df`; verify with `apksigner verify --print-certs`); there is no store listing yet.
:::

![Android app: agent list, dark-mode chat and the Connect a machine screen](/img/android-trio.webp)

## Get the APK

<!-- Switch these links back to /releases/latest once a stable (non-pre-release) release exists: /latest skips pre-releases. -->
- **Releases:** <https://github.com/TinkerDoge/FoxFleet/releases> (file `foxfleet-<version>.apk`, with `SHA256SUMS`).
- **Build it yourself:** see [Development](/project/development). In short, with JDK 17 and the Android SDK: `cd android && ./gradlew assembleDebug`, then install `app/build/outputs/apk/debug/app-debug.apk`.

Android will ask you to allow *Install unknown apps* for the app you opened the file with (browser or file manager).

## Debug and release side by side

A debug build (`./gradlew assembleDebug`, or the `foxfleet-debug-apk` CI artifact) installs **next to** the release app: the release app is `dev.foxfleet.app` (name **FoxFleet**), the debug app is `dev.foxfleet.app.debug` (name **FoxFleet Debug**, version suffix `-debug`, launcher icon with a red DEBUG badge on an orange background). They have separate data, so each keeps its own hubs and sign-in. Both open `foxfleet://` links, so Android may ask which one to use; pick the one you want (or "Just once").

## Connect to your hub

On first launch the app asks for a **hub address**. Three ways:

1. **Scan QR.** In the web app: *Admin → Pair a phone* shows a QR for `foxfleet://connect?hub=https://your-hub`. The app uses Google's code scanner (ML Kit, no camera permission needed; requires Google Play services). Without Play services, type the address.
2. **Open a link.** Tapping a `foxfleet://connect?hub=…` link on the phone opens the app with the address filled in.
3. **Type it.** Enter e.g. `https://hub.example.com`. The app checks the hub (`GET /api/auth`) before saving it.

`https://` is required, except for LAN or dev hubs: enable **Allow http on this network** to accept a private address. The app supports **several hubs** and lets you switch between them.

Then sign in, or create the owner/join with an invite if the hub is new. See [Using the apps](/apps/chat).
