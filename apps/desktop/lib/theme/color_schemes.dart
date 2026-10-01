import 'package:flutter/material.dart';

/// M3 取色令牌，逐值对应 Electron 版 `src/tokens/theme.css`。
///
/// 这里刻意不使用 `ColorScheme.fromSeed`：M3 的动态色算法只会给出「近似」的
/// 一组颜色，而 theme.css 里是人工调过的确定值。逐值搬过来才能保证换壳前后
/// 的观感一致（封面取色 Monet 属于后续阶段的增强）。
class SmColorSchemes {
  SmColorSchemes._();

  static const ColorScheme light = ColorScheme(
    brightness: Brightness.light,
    primary: Color(0xFF1A5C9E),
    onPrimary: Color(0xFFFFFFFF),
    primaryContainer: Color(0xFFD2E4FF),
    onPrimaryContainer: Color(0xFF001C3B),
    secondary: Color(0xFF535F70),
    onSecondary: Color(0xFFFFFFFF),
    secondaryContainer: Color(0xFFD7E3F7),
    onSecondaryContainer: Color(0xFF101C2B),
    tertiary: Color(0xFF6B5778),
    onTertiary: Color(0xFFFFFFFF),
    tertiaryContainer: Color(0xFFF2DAFF),
    onTertiaryContainer: Color(0xFF251431),
    error: Color(0xFFBA1A1A),
    onError: Color(0xFFFFFFFF),
    errorContainer: Color(0xFFFFDAD6),
    onErrorContainer: Color(0xFF410002),
    surface: Color(0xFFFCFCFC),
    onSurface: Color(0xFF1A1C1E),
    surfaceDim: Color(0xFFDADDE0),
    surfaceBright: Color(0xFFFCFCFC),
    surfaceContainerLowest: Color(0xFFFFFFFF),
    surfaceContainerLow: Color(0xFFF6F7F9),
    surfaceContainer: Color(0xFFF2F3F5),
    // 注意：#ECEEE0 是 theme.css 里的原值（不是笔误漏掉的一位），
    // 1:1 保留以免与 Electron 版的 hover 底色出现肉眼可见的偏差。
    surfaceContainerHigh: Color(0xFFECEEE0),
    surfaceContainerHighest: Color(0xFFE2E4E7),
    onSurfaceVariant: Color(0xFF44474E),
    outline: Color(0xFF7A7E87),
    outlineVariant: Color(0xFFC4C6CF),
    inverseSurface: Color(0xFF2F3033),
    onInverseSurface: Color(0xFFF1F0F4),
    inversePrimary: Color(0xFFA4C9FF),
    scrim: Color(0xB3000000),
    shadow: Color(0xFF000000),
    surfaceTint: Color(0xFF1A5C9E),
  );

  static const ColorScheme dark = ColorScheme(
    brightness: Brightness.dark,
    primary: Color(0xFF8BB9F0),
    onPrimary: Color(0xFF001C3B),
    primaryContainer: Color(0xFF002E5E),
    onPrimaryContainer: Color(0xFFD2E4FF),
    secondary: Color(0xFFBBC7DB),
    onSecondary: Color(0xFF253140),
    secondaryContainer: Color(0xFF3B4758),
    onSecondaryContainer: Color(0xFFD7E3F7),
    tertiary: Color(0xFFD6BEE4),
    onTertiary: Color(0xFF3B2948),
    tertiaryContainer: Color(0xFF523F5F),
    onTertiaryContainer: Color(0xFFF2DAFF),
    error: Color(0xFFFFB4AB),
    onError: Color(0xFF690005),
    errorContainer: Color(0xFF93000A),
    onErrorContainer: Color(0xFFFFDAD6),
    surface: Color(0xFF0F0F11),
    onSurface: Color(0xFFE2E2E5),
    surfaceDim: Color(0xFF0F0F11),
    surfaceBright: Color(0xFF3A3A3D),
    surfaceContainerLowest: Color(0xFF0A0A0C),
    surfaceContainerLow: Color(0xFF131316),
    surfaceContainer: Color(0xFF1A1C1E),
    surfaceContainerHigh: Color(0xFF24262A),
    surfaceContainerHighest: Color(0xFF2E3035),
    onSurfaceVariant: Color(0xFFC7C9CD),
    outline: Color(0xFF8F939B),
    outlineVariant: Color(0xFF44474E),
    inverseSurface: Color(0xFFE2E2E5),
    onInverseSurface: Color(0xFF2F3033),
    inversePrimary: Color(0xFF0061A4),
    scrim: Color(0xD9000000),
    shadow: Color(0xFF000000),
    surfaceTint: Color(0xFF8BB9F0),
  );
}
