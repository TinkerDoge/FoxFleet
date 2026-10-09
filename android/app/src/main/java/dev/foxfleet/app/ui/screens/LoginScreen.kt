package dev.foxfleet.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.foxfleet.app.data.AuthInfo
import dev.foxfleet.app.data.HubApi
import dev.foxfleet.app.data.HubApiException
import dev.foxfleet.app.data.Terms
import dev.foxfleet.app.data.scrubAddresses
import dev.foxfleet.app.ui.LocalHubColors
import dev.foxfleet.app.ui.motion.rememberHaptic
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

enum class AuthMode { SignIn, Setup, Register }

/** Which form to show for what the hub reports: first run creates the owner; otherwise sign in (or join if the hub allows it). */
fun authModeFor(info: AuthInfo?, wantsJoin: Boolean): AuthMode = when {
    info == null -> AuthMode.SignIn
    info.setupRequired -> AuthMode.Setup
    wantsJoin && info.registration != "closed" -> AuthMode.Register
    else -> AuthMode.SignIn
}

@Composable
fun fieldColors() = LocalHubColors.current.let { c ->
    OutlinedTextFieldDefaults.colors(
        focusedTextColor = c.text, unfocusedTextColor = c.text,
        focusedBorderColor = c.accent, unfocusedBorderColor = c.hairline,
        focusedContainerColor = c.surface, unfocusedContainerColor = c.surface,
        cursorColor = c.accent, focusedLabelColor = c.accent, unfocusedLabelColor = c.textMuted,
    )
}

/** Account form for the active hub: sign in, first-run owner setup, or join with an invite. Passwords are never stored. */
@Composable
fun LoginScreen(hubName: String, api: HubApi, notice: String?, onChangeHub: () -> Unit, onLoggedIn: () -> Unit, previewInfo: AuthInfo? = null, previewJoin: Boolean = false, inviteCode: String = "") {
    val c = LocalHubColors.current
    var info by remember { mutableStateOf(previewInfo) }
    var wantsJoin by remember { mutableStateOf(previewJoin || inviteCode.isNotBlank()) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf(inviteCode) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(notice) }
    val scope = rememberCoroutineScope()
    val haptic = rememberHaptic()
    LaunchedEffect(previewInfo) { if (previewInfo == null) runCatching { api.authInfo() }.onSuccess { info = it } }
    val mode = authModeFor(info, wantsJoin)
    // Terms of Use / Privacy Policy: required when creating the owner or joining; remembered per hub and version on this device.
    val context = LocalContext.current
    val termsVersion = info?.termsVersion ?: Terms.FALLBACK_VERSION
    val needsTerms = mode != AuthMode.SignIn
    var agreed by remember(hubName, termsVersion) { mutableStateOf(runCatching { Terms.accepted(Terms.prefs(context), hubName, termsVersion) }.getOrDefault(false)) }
    val canSubmit = !busy && (!needsTerms || agreed) && username.isNotBlank() && password.isNotEmpty() && (mode != AuthMode.Setup || password.length >= 10) && (mode != AuthMode.Register || password.length >= 10)

    fun submit() {
        if (!canSubmit) return
        busy = true; error = null
        scope.launch {
            try {
                when (mode) {
                    AuthMode.Setup -> api.setup(username.trim(), password, code.trim(), termsVersion)
                    AuthMode.Register -> api.register(username.trim(), password, code.trim(), termsVersion)
                    AuthMode.SignIn -> api.login(username.trim(), password)
                }
                if (needsTerms) runCatching { Terms.remember(Terms.prefs(context), hubName, termsVersion) }
                haptic(HapticFeedbackType.Confirm)
                onLoggedIn()
            } catch (e: CancellationException) { throw e } catch (e: HubApiException) {
                error = e.message
            } catch (e: Exception) {
                error = e.message?.let { scrubAddresses(it) } ?: "Couldn't sign in"
            } finally { busy = false }
        }
    }

    Column(
        Modifier.fillMaxSize().background(c.bg).systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(28.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Spacer(Modifier.height(32.dp))
        dev.foxfleet.app.ui.components.BrandWordmark(Modifier.fillMaxWidth(0.82f).height(52.dp))
        Spacer(Modifier.height(14.dp))
        Text(
            when (mode) { AuthMode.Setup -> "Set up your hub: create the owner account"; AuthMode.Register -> "Create your account"; AuthMode.SignIn -> "Sign in to your fleet console" },
            style = MaterialTheme.typography.bodyMedium, color = c.textMuted,
        )
        Text(hubName, style = MaterialTheme.typography.labelMedium, color = c.textFaint, modifier = Modifier.padding(top = 4.dp))
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(username, { username = it }, label = { Text("Username") }, singleLine = true, shape = RoundedCornerShape(14.dp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Next), modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(password, { password = it }, label = { Text(if (mode == AuthMode.SignIn) "Password" else "Password (10+ characters)") }, singleLine = true, shape = RoundedCornerShape(14.dp),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = if (mode == AuthMode.SignIn) ImeAction.Go else ImeAction.Next),
            keyboardActions = KeyboardActions(onGo = { submit() }), modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        if ((mode == AuthMode.Setup && info?.setupCodeRequired == true) || (mode == AuthMode.Register && info?.registration == "invite")) {
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(code, { code = it }, label = { Text(if (mode == AuthMode.Setup) "Setup code (printed when the hub starts)" else "Invite code") }, singleLine = true, shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth(), colors = fieldColors())
        }
        if (needsTerms) {
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(agreed, { agreed = it }, colors = CheckboxDefaults.colors(checkedColor = c.accent, uncheckedColor = c.textMuted))
                val link = TextLinkStyles(SpanStyle(color = c.accent, fontWeight = FontWeight.Medium))
                Text(buildAnnotatedString {
                    append("I agree to the ")
                    withLink(LinkAnnotation.Url(Terms.TERMS_URL, link)) { append("Terms of Use") }
                    append(" and ")
                    withLink(LinkAnnotation.Url(Terms.PRIVACY_URL, link)) { append("Privacy Policy") }
                    append(".")
                }, style = MaterialTheme.typography.bodyMedium, color = c.textMuted)
            }
        }
        Spacer(Modifier.height(20.dp))
        PrimaryAction(when (mode) { AuthMode.Setup -> "Create owner"; AuthMode.Register -> "Create account"; AuthMode.SignIn -> "Sign in" }.let { if (busy) "$it…" else it }, Modifier.fillMaxWidth(), busy, enabled = canSubmit) { submit() }
        error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, style = MaterialTheme.typography.bodyMedium, color = c.textMuted, modifier = Modifier.align(Alignment.CenterHorizontally))
        }
        Spacer(Modifier.height(12.dp))
        if (mode != AuthMode.Setup && info?.registration?.let { it != "closed" } == true) {
            TextButton(onClick = { wantsJoin = !wantsJoin; error = null }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                Text(if (wantsJoin) "I already have an account" else "Create an account", color = c.accent)
            }
        }
        TextButton(onClick = onChangeHub, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Use a different hub", color = c.textMuted) }
    }
}
