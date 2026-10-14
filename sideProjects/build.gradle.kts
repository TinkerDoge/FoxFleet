// Plugin markers are fetched through the Gradle Plugin Portal, which is not
// reachable from this build environment, so plugins are applied from the
// buildscript classpath instead (see app/build.gradle.kts).
buildscript {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.5.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21")
        classpath("org.jetbrains.kotlin:compose-compiler-gradle-plugin:2.0.21")
    }
}
