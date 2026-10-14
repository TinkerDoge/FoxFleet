import java.util.Properties
import java.io.File

plugins {
    // Versions come from the root buildscript classpath (portal unreachable here).
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Reuse FoxFleet's local signing configuration without copying credentials into this project.
val signingPropertiesFile = rootProject.file("keystore.properties").takeIf { it.isFile }
    ?: generateSequence(rootDir) { it.parentFile }
        .map { File(it, "android/keystore.properties") }
        .firstOrNull { it.isFile }
val signingProperties = Properties().apply {
    signingPropertiesFile?.reader()?.use { load(it) }
}
fun signingValue(environment: String, property: String): String? =
    System.getenv(environment)?.takeIf { it.isNotBlank() }
        ?: signingProperties.getProperty(property)?.takeIf { it.isNotBlank() }
val releaseStore = signingValue("FOXFLEET_KEYSTORE", "storeFile")
val releaseStorePassword = signingValue("FOXFLEET_KEYSTORE_PASSWORD", "storePassword")
val releaseAlias = signingValue("FOXFLEET_KEY_ALIAS", "keyAlias")
val releaseKeyPassword = signingValue("FOXFLEET_KEY_PASSWORD", "keyPassword")
val releaseSigningAvailable = listOf(releaseStore, releaseStorePassword, releaseAlias, releaseKeyPassword).all { it != null }

android {
    namespace = "vn.mint.taivideo"
    compileSdk = 34

    defaultConfig {
        applicationId = "vn.mint.taivideo"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        ndk {
            abiFilters += providers.gradleProperty("dogeAbis").orElse("arm64-v8a").get().split(",")
        }
    }

    signingConfigs {
        if (releaseSigningAvailable) create("release") {
            storeFile = file(requireNotNull(releaseStore))
            storePassword = releaseStorePassword
            keyAlias = releaseAlias
            keyPassword = releaseKeyPassword
        }
    }
    buildTypes {
        debug {
        }
        release {
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
    }
    packaging {
        jniLibs.useLegacyPackaging = true
    }
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        check(releaseSigningAvailable) {
            "FoxFleet signing credentials are required. Provide ignored keystore.properties or FOXFLEET signing environment variables."
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.5")
    implementation("io.coil-kt:coil-compose:2.6.0")
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
}
