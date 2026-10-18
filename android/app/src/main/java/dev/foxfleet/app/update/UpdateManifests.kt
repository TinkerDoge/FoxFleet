package dev.foxfleet.app.update

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The auto-update manifest (0.4.3 C4). The parent publishes this JSON (DogeDrive / INDC) at a stable HTTPS URL:
 *
 * ```json
 * { "versionCode": 35, "versionName": "0.4.3-alpha", "apkUrl": "https://…/FoxFleet.apk", "sha256": "…", "notes": "optional" }
 * ```
 *
 * [apkUrl] must be a direct HTTPS file, not a Drive view page: the app never runs OAuth.
 */
data class UpdateManifest(
    val versionCode: Int,
    val versionName: String,
    val apkUrl: String,
    val sha256: String,
    val notes: String? = null,
)

/** Where the app looks for the manifest, and how to read one. */
object UpdateManifests {
    /** Configurable constant: the parent points this at the live DogeDrive/INDC manifest. */
    const val DEFAULT_URL = "https://doge-drive.foxfleet.dev/apk/manifest.json"
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Parse a manifest body; null for anything missing or malformed (never guessed). */
    fun parse(body: String): UpdateManifest? {
        val o = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        val code = o["versionCode"]?.jsonPrimitive?.intOrNull ?: return null
        val name = o["versionName"]?.jsonPrimitive?.contentOrNull ?: return null
        val url = o["apkUrl"]?.jsonPrimitive?.contentOrNull ?: return null
        val sha = o["sha256"]?.jsonPrimitive?.contentOrNull ?: return null
        return UpdateManifest(code, name, url, sha, o["notes"]?.jsonPrimitive?.contentOrNull)
    }
}

/** The update decision, pure and testable: only a strictly greater versionCode is an update. */
object UpdatePolicy {
    fun isNewer(installedVersionCode: Int, manifest: UpdateManifest): Boolean = manifest.versionCode > installedVersionCode

    /** A hash check that rejects blank or mismatched digests: an install never runs on a mismatch. */
    fun shaMatches(expected: String, actual: String): Boolean = expected.isNotBlank() && actual.equals(expected, ignoreCase = true)

    /** Downloads are HTTPS only; a plain-http or Drive view link is refused before any byte moves. */
    fun isHttps(url: String): Boolean = url.startsWith("https://", ignoreCase = true)
}

/** What a check decided, before anything is downloaded. */
sealed interface UpdatePlan {
    data class Update(val manifest: UpdateManifest) : UpdatePlan
    data object UpToDate : UpdatePlan
    data class Refused(val why: String) : UpdatePlan

    companion object {
        fun decide(installedVersionCode: Int, manifest: UpdateManifest): UpdatePlan = when {
            !UpdatePolicy.isHttps(manifest.apkUrl) -> Refused("The update link is not HTTPS.")
            manifest.sha256.isBlank() -> Refused("The update has no checksum.")
            UpdatePolicy.isNewer(installedVersionCode, manifest) -> Update(manifest)
            else -> UpToDate
        }
    }
}

/** What the Settings row and the cold-start prompt show. */
sealed interface UpdateUi {
    data object Idle : UpdateUi
    data object Checking : UpdateUi
    data object UpToDate : UpdateUi
    data class Available(val manifest: UpdateManifest) : UpdateUi
    data class Downloading(val percent: Int) : UpdateUi
    data class Installing(val manifest: UpdateManifest) : UpdateUi
    data class Failed(val message: String) : UpdateUi
}
