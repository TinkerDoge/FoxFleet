# Install the Android app

The app is `dev.foxfleet.app` (name **Foxfleet**), minimum Android 10 (API 29), built with Kotlin and Jetpack Compose.

::: warning Status: not verified on a physical device
Unit tests and screenshot tests (Roborazzi) pass in development and the APK assembles, but the maintainers have not yet run the current build end to end on a physical device. Builds are **debug-signed**; there is no release keystore or store listing yet.
:::

## Get the APK

- **Releases:** <https://github.com/TinkerDoge/FoxFleet/releases> (placeholder until the first release is published).
- **Build it yourself:** see [Development](/project/development). In short, with JDK 17 and the Android SDK: `cd android && ./gradlew assembleDebug`, then install `app/build/outputs/apk/debug/app-debug.apk`.

Android will ask you to allow *Install unknown apps* for the app you opened the file with (browser or file manager).

## Connect to your hub

On first launch the app asks for a **hub address**. Three ways:

1. **Scan QR.** In the web app: *Admin → Pair a phone* shows a QR for `foxfleet://connect?hub=https://your-hub`. The app uses Google's code scanner (ML Kit, no camera permission needed; requires Google Play services). Without Play services, type the address.
2. **Open a link.** Tapping a `foxfleet://connect?hub=…` link on the phone opens the app with the address filled in.
3. **Type it.** Enter e.g. `https://hub.example.com`. The app checks the hub (`GET /api/auth`) before saving it.

`https://` is required, except for LAN or dev hubs: enable **Allow http on this network** to accept a private address. The app supports **several hubs** and lets you switch between them.

Then sign in, or create the owner/join with an invite if the hub is new. See [Using the apps](/apps/chat).
