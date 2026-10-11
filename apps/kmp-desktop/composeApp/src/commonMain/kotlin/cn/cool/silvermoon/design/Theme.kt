package cn.cool.silvermoon.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.materialkolor.DynamicMaterialExpressiveTheme
import com.materialkolor.PaletteStyle

/**
 * SilverMoon 的 Material 3 / M3 Expressive 主题。
 *
 * 复刻要点（对应 web 端 apps/desktop/src/m3e.ts + tokens/theme.css + settings 的取色逻辑）：
 *   - 主题基座是 **MaterialExpressiveTheme**，不是普通 MaterialTheme —— 按钮形变、
 *     加载指示器、弹簧动效这些 M3E 特性都挂在它上面；
 *   - 颜色走 **Monet 动态取色**：种子色来自用户设置，或 Windows 系统强调色；
 *   - 浅色 / 深色 / 跟随系统三态；
 *   - 形状与设计令牌在下面一键注入，页面里不再各写各的圆角。
 */
enum class ThemeMode { System, Light, Dark }

/** web 端默认种子色：theme.css 里 --md-sys-color-primary 的浅色基准 #1a5c9e。 */
val DefaultSeedColor = Color(0xFF1A5C9E)

/** M3 形状阶：与 theme.css 的 --md-sys-shape-corner-* 一一对应。 */
val SilverMoonShapes = Shapes(
    extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(4.dp),
    small = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
    extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(28.dp),
)

/** 主题入口。isSystemDark 由平台层注入，方便 Windows 上跟随系统深色设置。 */
// CMP 1.12 把 ExperimentalMaterial3ExpressiveApi 转成了 internal（M3E API 转正），
// 于是它既不能被 @OptIn 指名，又仍然被 materialKolor 的包装函数带在元数据里 ——
// 只能在使用点压制这个 opt-in 诊断。等 materialKolor 发版对齐后再撤掉。
@Suppress("OPT_IN_USAGE", "OPT_IN_USAGE_ERROR")
@Composable
fun SilverMoonTheme(
    mode: ThemeMode = ThemeMode.System,
    seedColor: Color = DefaultSeedColor,
    isSystemDark: Boolean = isSystemInDarkTheme(),
    animationEnabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val isDark = when (mode) {
        ThemeMode.System -> isSystemDark
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    DynamicMaterialExpressiveTheme(
        seedColor = seedColor,
        isDark = isDark,
        isAmoled = false,
        style = PaletteStyle.Expressive,
        shapes = SilverMoonShapes,
        typography = Typography(),
        animate = animationEnabled,
    ) {
        CompositionLocalProvider(
            LocalSilverMoonTokens provides tokensFor(isDark),
            content = content,
        )
    }
}

/** 在不启动动态取色的场景下（截图测试 / 预览）用的静态配色。 */
@Composable
fun SilverMoonStaticTheme(dark: Boolean, content: @Composable () -> Unit) {
    val scheme = if (dark) darkColorScheme() else lightColorScheme()
    MaterialTheme(colorScheme = scheme, shapes = SilverMoonShapes, content = content)
}
