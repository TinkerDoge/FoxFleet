package dev.foxfleet.app

import android.app.Application
import android.content.ComponentName
import android.content.pm.ActivityInfo
import androidx.activity.ComponentActivity
import org.robolectric.Shadows
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import kotlinx.coroutines.Dispatchers

/**
 * Application for every Robolectric test (src/test/resources/robolectric.properties).
 *
 * Why (0.3.12, CI exit 134): Coil 3's default singleton ImageLoader fetches and decodes on
 * Dispatchers.IO. Under @GraphicsMode(NATIVE) that decode calls Robolectric's native graphics runtime
 * from a background thread; its lazy JniConstants init there can fail ("JniConstants F ... Class not
 * found: java/nio/FloatBuffer|ShortBuffer|DoubleBuffer"), which is LOG_ALWAYS_FATAL -> SIGABRT ->
 * "Gradle Test Executor N finished with non-zero exit value 134" with no failing test. Known
 * Coil 3 + Robolectric NATIVE issue (coil-kt/coil#3049). Keeping all Coil work on the Robolectric
 * main thread keeps native graphics calls on the sandbox thread, where they are safe.
 * The app's own loader (MainActivity) is unchanged.
 */
class RoboTestApp : Application(), SingletonImageLoader.Factory {
    /**
     * createComposeRule() launches androidx.activity.ComponentActivity, which only reaches the manifest
     * through debugImplementation(ui-test-manifest). Robolectric reads the variant's own packaged
     * manifest, so testReleaseUnitTest had 178 "Unable to resolve activity" failures. Register it
     * here (test-only) when the manifest lacks it; the release APK stays unchanged.
     */
    override fun onCreate() {
        super.onCreate()
        val cn = ComponentName(this, ComponentActivity::class.java)
        val known = runCatching { packageManager.getActivityInfo(cn, 0) }.isSuccess
        if (!known) {
            Shadows.shadowOf(packageManager).addOrUpdateActivity(
                ActivityInfo().apply { name = cn.className; packageName = packageName(); exported = true }
            )
        }
    }

    private fun packageName(): String = getPackageName()

    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .coroutineContext(Dispatchers.Main.immediate)
            .fetcherCoroutineContext(Dispatchers.Main.immediate)
            .decoderCoroutineContext(Dispatchers.Main.immediate)
            .diskCache(null)
            .build()
}
