import 'package:flutter/material.dart';

import '../i18n/sm_strings.dart';

/// 桌面端全局 UI 状态（界面框架阶段只有主题与语言）。
///
/// 阶段说明：持久化属于后续阶段。Electron 版把设置写进 appData 下的
/// settings.json（76 项 + audio-effects.json 6 项），Flutter 侧必须复用同一
/// 数据目录与同一份 JSON 结构（方案 §7.3）。这里先只放在内存里，
/// 接入 JsonStore 后把 setter 改成「内存 + 落盘」即可，调用方不用动。
class AppState extends ChangeNotifier {
  static const List<Locale> supportedLocales = <Locale>[Locale('zh'), Locale('en')];

  ThemeMode _themeMode = ThemeMode.system;
  Locale _locale = const Locale('zh');

  ThemeMode get themeMode => _themeMode;
  Locale get locale => _locale;

  /// 当前语言的词条表。
  SmStrings get strings => SmStrings(_locale.languageCode);

  void setThemeMode(ThemeMode mode) {
    if (mode == _themeMode) return;
    _themeMode = mode;
    notifyListeners();
  }

  void setLocale(Locale locale) {
    if (locale.languageCode == _locale.languageCode) return;
    _locale = Locale(locale.languageCode);
    notifyListeners();
  }
}
