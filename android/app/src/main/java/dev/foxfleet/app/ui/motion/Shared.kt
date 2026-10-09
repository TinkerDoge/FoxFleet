package dev.foxfleet.app.ui.motion

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier

@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedScope = compositionLocalOf<SharedTransitionScope?> { null }
val LocalNavAnimScope = compositionLocalOf<AnimatedVisibilityScope?> { null }

/** Fleet card avatar ↔ chat header avatar. No-op outside the nav host (previews, tests). */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedAvatar(agent: String): Modifier {
    val s = LocalSharedScope.current ?: return this
    val a = LocalNavAnimScope.current ?: return this
    if (reduceMotion()) return this
    return with(s) { this@sharedAvatar.sharedElement(rememberSharedContentState("avatar-$agent"), a) }
}
