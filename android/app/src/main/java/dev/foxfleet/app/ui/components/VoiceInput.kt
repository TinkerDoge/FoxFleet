package dev.foxfleet.app.ui.components

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** Joins text already in the composer with what the recogniser heard. */
fun mergeDictation(before: String, heard: String): String = when {
    heard.isBlank() -> before
    before.isBlank() -> heard.replaceFirstChar { it.uppercase() }
    before.endsWith(" ") || before.endsWith("\n") -> before + heard
    else -> "$before $heard"
}

/** Android SpeechRecognizer wrapper: streams partial text into the composer. */
class VoiceInput(private val context: Context) {
    var listening by mutableStateOf(false); private set
    var level by mutableStateOf(0f); private set
    var error by mutableStateOf<String?>(null); private set
    private var recognizer: SpeechRecognizer? = null

    val available: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)

    fun start(onText: (partial: String, final: Boolean) -> Unit) {
        if (listening) return
        error = null
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { listening = true }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) { level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() { level = 0f }
            override fun onError(code: Int) {
                listening = false; level = 0f
                error = when (code) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Didn't catch that"
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission needed"
                    SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Voice needs a connection"
                    else -> "Voice input stopped"
                }
            }
            override fun onResults(results: Bundle?) {
                listening = false; level = 0f
                results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { onText(it, true) }
            }
            override fun onPartialResults(partial: Bundle?) {
                partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { onText(it, false) }
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        r.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        })
        listening = true
    }

    fun stop() { recognizer?.stopListening(); listening = false; level = 0f }

    fun release() { recognizer?.destroy(); recognizer = null; listening = false }
}
