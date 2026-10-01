import 'package:flutter/material.dart';

import '../i18n/sm_strings.dart';

/// 桌面端全局 UI 状态（主题与语言）。
///
/// 主题 / 语言的**真源**是 appData 下的 settings.json（与 Electron 版共用同一份文件、
/// 同一套键名，见 host/settings_store.dart）。这里的字段是它在界面上的投影：
///   * 启动时由 main.dart 用磁盘值调 [applyStored] 初始化；
///   * 之后任何改动都通过 [onPersist] 写回 settings.json —— 标题栏的外观菜单改主题
///     同样会落盘，不必先打开设置页。
class AppState extends ChangeNotifier {
  static const List<Locale> supportedLocales = <Locale>[Locale('zh'), Locale('en')];

  ThemeMode _themeMode = ThemeMode.system;
  Locale _locale = const Locale('zh');

  /// 主题 / 语言变化时的落盘回调（由 main.dart 在宿主就绪后注入）。
  void Function(String key, Object? value)? onPersist;

  ThemeMode get themeMode => _themeMode;
  Locale get locale => _locale;

  /// 当前语言的词条表。
  SmStrings get strings => SmStrings(_locale.languageCode);

  /// 用磁盘上的设置初始化（启动时调用一次，早于注入 [onPersist]）。
  void applyStored({String? theme, String? lang}) {
    final ThemeMode mode = themeModeOf(theme);
    final Locale locale = Locale(lang == 'en' ? 'en' : 'zh');
    bool changed = false;
    if (mode != _themeMode) {
      _themeMode = mode;
      changed = true;
    }
    if (locale.languageCode != _locale.languageCode) {
      _locale = locale;
      changed = true;
    }
    if (changed) notifyListeners();
  }

  void setThemeMode(ThemeMode mode) {
    if (mode == _themeMode) return;
    _themeMode = mode;
    onPersist?.call('theme', themeKeyOf(mode));
    notifyListeners();
  }

  void setLocale(Locale locale) {
    if (locale.languageCode == _locale.languageCode) return;
    _locale = Locale(locale.languageCode);
    onPersist?.call('lang', _locale.languageCode);
    notifyListeners();
  }

  /// settings.json 的主题字符串 → ThemeMode（取值与 Electron 版一致）。
  static ThemeMode themeModeOf(String? raw) {
    switch (raw) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      default:
        return ThemeMode.system;
    }
  }

  /// ThemeMode → settings.json 的主题字符串。
  static String themeKeyOf(ThemeMode mode) {
    switch (mode) {
      case ThemeMode.light:
        return 'light';
      case ThemeMode.dark:
        return 'dark';
      case ThemeMode.system:
        return 'system';
    }
  }
}
