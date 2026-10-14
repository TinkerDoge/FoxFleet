package vn.mint.taivideo

import android.Manifest
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import vn.mint.taivideo.ui.DogeDownloaderScreen
import vn.mint.taivideo.ui.DogeDownloaderTheme
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun attachBaseContext(newBase: Context) {
        val vietnamese = Locale.forLanguageTag("vi-VN")
        val configuration = Configuration(newBase.resources.configuration).apply {
            setLocale(vietnamese)
            setLayoutDirection(vietnamese)
        }
        super.attachBaseContext(newBase.createConfigurationContext(configuration))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        handleShareIntent(intent)
        setContent { DogeDownloaderTheme { DogeDownloaderScreen(vm) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type == "text/plain") {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
            val url = Regex("https?://\\S+", RegexOption.IGNORE_CASE).find(text)?.value ?: return
            vm.editUrl(url)
            vm.fetchInfo()
        }
    }
}
