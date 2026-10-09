import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.roborazzi)
}

android {
    namespace = "dev.foxfleet.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.foxfleet.app"
        minSdk = 29
        targetSdk = 35
        versionCode = 3
        versionName = "0.1.0-alpha"
    }

    // Release signing. The keystore is NEVER in the repository. Provide it either through environment variables
    // (CI: FOXFLEET_KEYSTORE = path to the .jks, FOXFLEET_KEYSTORE_PASSWORD, FOXFLEET_KEY_ALIAS, FOXFLEET_KEY_PASSWORD)
    // or an untracked android/keystore.properties with the same keys in lower camel case (storeFile, storePassword,
    // keyAlias, keyPassword). Without either, `assembleRelease` produces an UNSIGNED apk (fine for CI smoke builds).
    // See docs/development: "Signing a release".
    val keystoreProps = Properties().apply { rootProject.file("keystore.properties").takeIf { it.exists() }?.reader()?.use { load(it) } }
    fun signingValue(env: String, prop: String): String? = System.getenv(env)?.takeIf { it.isNotBlank() } ?: keystoreProps.getProperty(prop)
    val releaseStore = signingValue("FOXFLEET_KEYSTORE", "storeFile")
    signingConfigs {
        if (releaseStore != null) create("release") {
            storeFile = file(releaseStore)
            storePassword = signingValue("FOXFLEET_KEYSTORE_PASSWORD", "storePassword")
            keyAlias = signingValue("FOXFLEET_KEY_ALIAS", "keyAlias")
            keyPassword = signingValue("FOXFLEET_KEY_PASSWORD", "keyPassword")
        }
    }

    buildTypes {
        release {
            // R8/minify is OFF for the alpha: the app uses reflection-heavy libraries (kotlinx.serialization, Rive, a JS-bridged
            // WebView) and there is no on-device test suite to prove a minified build works. Turn it on once device tests exist.
            isMinifyEnabled = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.animation)
    implementation(libs.compose.icons.core)
    implementation(libs.rive.android)
    implementation(libs.markdown.m3)
    implementation(libs.markdown.coil3)
    implementation(libs.coil.compose)
    implementation(libs.coil.okhttp)
    implementation(libs.telephoto)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.okhttp)
    implementation(libs.exifinterface)
    implementation(libs.webkit)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    implementation(libs.codescanner) // Google code scanner: no camera permission; QR pairing on the first-launch screen
    testImplementation(libs.roborazzi)
    testImplementation(libs.roborazzi.compose)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
