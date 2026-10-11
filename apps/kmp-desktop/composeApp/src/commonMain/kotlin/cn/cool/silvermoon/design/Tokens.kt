package cn.cool.silvermoon.design

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * 应用级设计令牌。
 *
 * 数值逐个对应 web 端 apps/desktop/src/tokens/theme.css 里的 CSS 变量，
 * 1:1 复刻不靠肉眼对齐：这里写死了同一批数字（标题栏 48、导航栏 88、
 * 迷你播放器 72、内容边距 24、卡片圆角 20 / 内层 12、对话框 28、毛玻璃 28px）。
 */
data class SilverMoonTokens(
    val titleBarHeight: Dp,
    val navRailWidth: Dp,
    val miniPlayerHeight: Dp,
    val contentPadding: Dp,
    val surfaceBlur: Dp,
    val hairline: Color,
    val scrimSurface: Color,
    val shapeButton: RoundedCornerShape,
    val shapeCard: RoundedCornerShape,
    val shapeCardInner: RoundedCornerShape,
    val shapeDialog: RoundedCornerShape,
    val shapeExtraLarge: RoundedCornerShape,
    val shapeFull: RoundedCornerShape,
    val gapXs: Dp,
    val gapSm: Dp,
    val gapMd: Dp,
    val gapLg: Dp,
    val gapXl: Dp,
)

/** 布局间距阶。web 端的 CSS 里散落着 4/8/12/16/24/32，这里收敛成一套。 */
object SilverMoonSpacing {
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 24.dp
    val xxl: Dp = 32.dp
}

/** M3 Expressive 的空间动效曲线（对应 web 端 theme.css 里的 spring 近似）。 */
object SilverMoonMotion {
    val emphasized: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val emphasizedDecelerate: Easing = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val emphasizedAccelerate: Easing = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    val standard: Easing = FastOutSlowInEasing

    const val durationShort = 200
    const val durationMedium = 300
    const val durationLong = 500
}

private val LightTokens = SilverMoonTokens(
    titleBarHeight = 48.dp,
    navRailWidth = 88.dp,
    miniPlayerHeight = 72.dp,
    contentPadding = 24.dp,
    surfaceBlur = 28.dp,
    hairline = Color(0x14000000),
    scrimSurface = Color(0xB8FCFCFC),
    shapeButton = RoundedCornerShape(999.dp),
    shapeCard = RoundedCornerShape(20.dp),
    shapeCardInner = RoundedCornerShape(12.dp),
    shapeDialog = RoundedCornerShape(28.dp),
    shapeExtraLarge = RoundedCornerShape(28.dp),
    shapeFull = RoundedCornerShape(999.dp),
    gapXs = SilverMoonSpacing.xs,
    gapSm = SilverMoonSpacing.sm,
    gapMd = SilverMoonSpacing.md,
    gapLg = SilverMoonSpacing.lg,
    gapXl = SilverMoonSpacing.xl,
)

private val DarkTokens = LightTokens.copy(
    hairline = Color(0x17FFFFFF),
    scrimSurface = Color(0xB8141417),
)

val LocalSilverMoonTokens = staticCompositionLocalOf { LightTokens }

/** 读取当前配置下的设计令牌。 */
val silverMoon: SilverMoonTokens
    @Composable @ReadOnlyComposable get() = LocalSilverMoonTokens.current

/** 供主题提供给 CompositionLocal 用。 */
internal fun tokensFor(isDark: Boolean): SilverMoonTokens = if (isDark) DarkTokens else LightTokens

/** 卡片/容器的描边色：M3 的 outlineVariant，但按 web 端的 hairline 透明度再压一档。 */
@Composable
@ReadOnlyComposable
fun hairlineColor(): Color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)
