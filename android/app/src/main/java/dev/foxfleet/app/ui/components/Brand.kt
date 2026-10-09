package dev.foxfleet.app.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import dev.foxfleet.app.R
import dev.foxfleet.app.ui.LocalHubColors

// Brand art is one swappable set (wooden fox "W3", picked by the owner): res/drawable-nodpi/brand_icon_fg.png
// (launcher foreground), brand_logo.png, brand_wordmark_light.png, brand_wordmark_dark.png and
// @color/brand_icon_bg. Replace those files to switch options; no code changes needed.

@Composable
fun BrandLogo(size: Dp, modifier: Modifier = Modifier) {
    Image(painterResource(R.drawable.brand_logo), "Foxfleet", modifier.size(size), contentScale = ContentScale.Fit)
}

@Composable
fun BrandWordmark(modifier: Modifier = Modifier) {
    val dark = LocalHubColors.current.dark
    Image(
        painterResource(if (dark) R.drawable.brand_wordmark_dark else R.drawable.brand_wordmark_light),
        "Foxfleet", modifier, contentScale = ContentScale.Fit,
    )
}
