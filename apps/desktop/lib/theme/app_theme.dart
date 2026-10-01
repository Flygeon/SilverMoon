import 'package:flutter/material.dart';

import 'color_schemes.dart';
import 'design_tokens.dart';

/// 桌面端 M3 主题构建。
///
/// 结构与 `apps/mobile/lib/theme/app_theme.dart` 保持一致，便于维护；
/// 差异在于这里用的是「逐值搬运」的固定 ColorScheme（见 color_schemes.dart），
/// 而不是 fromSeed。
class AppTheme {
  AppTheme._();

  static ThemeData light() => build(SmColorSchemes.light);

  static ThemeData dark() => build(SmColorSchemes.dark);

  static ThemeData build(ColorScheme scheme) {
    final bool dark = scheme.brightness == Brightness.dark;

    return ThemeData(
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      splashFactory: InkSparkle.splashFactory,
      visualDensity: VisualDensity.standard,
      appBarTheme: AppBarThemeData(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: AppText.titleLarge.copyWith(color: scheme.onSurface),
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant.withValues(alpha: dark ? 0.35 : 0.5),
        thickness: 0.6,
        space: 0.6,
      ),
      iconTheme: IconThemeData(color: scheme.onSurfaceVariant, size: 20),
      tooltipTheme: TooltipThemeData(
        waitDuration: const Duration(milliseconds: 500),
        decoration: BoxDecoration(
          color: scheme.inverseSurface,
          borderRadius: SM.rSmall,
        ),
        textStyle: AppText.bodySmall.copyWith(color: scheme.onInverseSurface),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: scheme.surfaceContainerHigh,
        surfaceTintColor: Colors.transparent,
        elevation: 3,
        shape: const RoundedRectangleBorder(borderRadius: SM.rMedium),
        textStyle: AppText.bodyMedium.copyWith(color: scheme.onSurface),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: const RoundedRectangleBorder(borderRadius: SM.rCardInner),
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: AppText.bodyMedium.copyWith(color: scheme.onInverseSurface),
      ),
      inputDecorationTheme: InputDecorationThemeData(
        filled: true,
        fillColor: scheme.surfaceContainerHigh,
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        border: const OutlineInputBorder(borderRadius: SM.rCardInner, borderSide: BorderSide.none),
        enabledBorder:
            const OutlineInputBorder(borderRadius: SM.rCardInner, borderSide: BorderSide.none),
        focusedBorder: OutlineInputBorder(
          borderRadius: SM.rCardInner,
          borderSide: BorderSide(color: scheme.primary, width: 1.5),
        ),
      ),
      sliderTheme: SliderThemeData(
        trackHeight: 4,
        activeTrackColor: scheme.primary,
        inactiveTrackColor: scheme.surfaceContainerHighest,
        thumbColor: scheme.primary,
        overlayColor: scheme.primary.withValues(alpha: 0.12),
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(color: scheme.primary),
    );
  }
}

/// 与 SM 令牌同源的文字样式快捷入口（字号/字重/行高全部来自 theme.css 的 M3 字阶）。
class AppText {
  AppText._();

  static const TextStyle titleLarge = SmText.titleLarge;
  static const TextStyle titleMedium = SmText.titleMedium;
  static const TextStyle titleSmall = SmText.titleSmall;
  static const TextStyle bodyMedium = SmText.bodyMedium;
  static const TextStyle bodySmall = SmText.bodySmall;
  static const TextStyle labelMedium = SmText.labelMedium;
  static const TextStyle labelSmall = SmText.labelSmall;
}

/// 全局拿令牌的快捷方式。
extension SmBuildContext on BuildContext {
  ColorScheme get scheme => Theme.of(this).colorScheme;
  TextTheme get text => Theme.of(this).textTheme;
  bool get isDark => Theme.of(this).brightness == Brightness.dark;

  /// 发丝分隔线（--lm-hairline）
  Color get hairline => Theme.of(this).colorScheme.outlineVariant.withValues(alpha: 0.45);
}
