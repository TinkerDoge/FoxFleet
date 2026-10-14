# DogeDownloader

Ứng dụng Android tải video và âm thanh, với giao diện tiếng Việt và nền tối cố định. Hỗ trợ dán liên kết hoặc chia sẻ liên kết từ ứng dụng khác, chọn chất lượng, tải nền, xem lịch sử, mở, chia sẻ và xóa bản lưu trong ứng dụng. Linh vật Shiba và các biểu tượng dùng phong cách pixel-art.

## Build on Windows

Use JDK 17 and an Android SDK with platform 34. The included Gradle wrapper matches FoxFleet's verified distribution. From this directory:

```powershell
.\build.ps1 -AndroidSdk 'E:\android-sdk' -JavaDirectory 'E:\android-tools\jdk-17.0.20.1+1'
```

The release build reads FoxFleet's existing ignored `android/keystore.properties` from an ancestor directory. A standalone checkout can use an ignored `keystore.properties` in this directory, or the same `FOXFLEET_KEYSTORE`, `FOXFLEET_KEYSTORE_PASSWORD`, `FOXFLEET_KEY_ALIAS`, and `FOXFLEET_KEY_PASSWORD` environment variables as FoxFleet. Release packaging fails when any signing value is missing. Never commit signing credentials or keystores.

The script builds, runs Android lint, verifies the APK signature, and writes `releases/DogeDownloader-1.0.apk` with a SHA-256 sidecar. The default APK targets arm64 phones and Android 8.0 or newer. The package remains `vn.mint.taivideo` to preserve existing app data. The display name is DogeDownloader.

## Language and files

All app-authored labels, accessibility descriptions, messages, and notifications are Vietnamese, including on phones set to another language. Android permission prompts and system file choosers follow Android's system language. External video titles and uploader names are preserved.

New public copies go to `Download/DogeDownloader` on Android 10 or newer. The private `taivideo` download directory and existing history remain compatible. Deleting a history item removes the private copy; the public copy is kept, as explained in the Vietnamese confirmation dialog.

FFmpeg is included and initialized for video/audio merging and MP3 conversion, following the library's documented setup: https://github.com/yausername/youtubedl-android#ffmpeg.

## Pixel-art assets and animation

`assets/pixel-shiba` contains transparent generated launcher artwork, a six-pose sprite sheet, 13 UI glyphs in SVG and Android XML formats, alignment metadata, checksums, and complete generation prompts. The reusable pack is `releases/DogeDownloader-PixelShiba-Assets.zip`.

The app always uses the dark amber theme, including when Android uses light mode. The Shiba blinks while visible and gently bobs during active downloads. Refresh and download icons animate during their operations. Idle blinking pauses when the activity is backgrounded. Sprite sampling uses nearest-neighbor filtering and measured alpha bounds.

## Verification boundary

Build, lint, certificate, APK resource checks, and emulator review are recorded in `VERIFICATION.md`. Successful downloads from each supported website and real-device usability still need phone testing.
