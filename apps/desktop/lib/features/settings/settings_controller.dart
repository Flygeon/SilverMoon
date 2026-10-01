import 'dart:async';

import 'package:flutter/material.dart';

import '../../host/settings_store.dart';
import '../../state/app_state.dart';
import 'settings_schema.dart';

/// 设置页状态：读全量 settings.json，改动即时生效 + 节流落盘。
///
/// 与 Electron 版 stores/settings.ts 对齐的三条语义：
///  1. 只覆盖改动过的字段（SettingsStore.merge 是合并写，不会抹掉尚未接管的字段）；
///  2. 节流落盘（拖动滑块不会几十次全量写文件），离开页面时立即 flush；
///  3. theme / lang 改动立即作用到 [AppState]，不必重启。
///
/// 字段默认值取自 schema（与归档 DEFAULTS 同源）：文件里没有该键时按默认值显示，
/// 但**不会**把默认值写进文件，避免凭空生成用户没设过的字段。
class SettingsController extends ChangeNotifier {
  SettingsController({required this.store, required this.appState});

  final SettingsStore store;
  final AppState appState;

  static const Duration _debounce = Duration(milliseconds: 400);

  final Map<String, Object?> _values = <String, Object?>{};
  Timer? _timer;
  bool _disposed = false;
  bool _loaded = false;

  /// 是否已从磁盘载入。
  bool get isLoaded => _loaded;

  /// 磁盘上的全部设置字段（含尚未接管的，只读用途）。
  Map<String, Object?> get values => Map<String, Object?>.unmodifiable(_values);

  /// 载入并应用主题 / 语言。
  void load() {
    _values
      ..clear()
      ..addAll(store.read());
    _loaded = true;
    appState.setThemeMode(AppState.themeModeOf(stringValue('theme', 'system')));
    appState.setLocale(Locale(stringValue('lang', 'zh') == 'en' ? 'en' : 'zh'));
    _notify();
  }

  /// 取某字段的当前值（磁盘值 → schema 默认值）。
  Object? valueOf(SmField field) => _values[field.key] ?? field.defaultValue;

  bool boolOf(SmField field) => valueOf(field) == true;

  double numOf(SmField field) {
    final Object? v = valueOf(field);
    if (v is num) return v.toDouble();
    return field.defaultValue is num ? (field.defaultValue! as num).toDouble() : field.min.toDouble();
  }

  String stringOf(SmField field) => valueOf(field)?.toString() ?? '';

  /// 未建模成字段的键（scanDirs / desktopLyricsBounds 等由专用编辑器维护）。
  String stringValue(String key, String fallback) {
    final Object? v = _values[key];
    return v is String ? v : fallback;
  }

  List<String> scanDirs() {
    final Object? v = _values['scanDirs'];
    if (v is! List) return <String>[];
    return v.whereType<String>().toList();
  }

  void addScanDir(String dir) {
    final String trimmed = dir.trim();
    if (trimmed.isEmpty) return;
    final List<String> dirs = scanDirs();
    if (dirs.contains(trimmed)) return;
    _values['scanDirs'] = <String>[...dirs, trimmed];
    _notify();
    unawaited(flush());
  }

  void removeScanDir(String dir) {
    final List<String> dirs = scanDirs();
    if (!dirs.remove(dir)) return;
    _values['scanDirs'] = dirs;
    _notify();
    unawaited(flush());
  }

  void clearScanDirs() {
    if (scanDirs().isEmpty) return;
    _values['scanDirs'] = <String>[];
    _notify();
    unawaited(flush());
  }

  /// 改一个字段：内存即时生效 → 应用到 AppState → 节流落盘。
  void set(SmField field, Object? next) {
    if (_values[field.key] == next) return;
    _values[field.key] = next;
    _applySideEffect(field.key, next);
    _notify();
    _schedule();
  }

  /// 直接改一个未建模的键（如 desktopLyricsBounds）。
  void setRaw(String key, Object? next) {
    if (_values[key] == next) return;
    _values[key] = next;
    _notify();
    _schedule();
  }

  void _applySideEffect(String key, Object? next) {
    switch (key) {
      case 'theme':
        appState.setThemeMode(AppState.themeModeOf(next?.toString() ?? 'system'));
      case 'lang':
        appState.setLocale(Locale(next == 'en' ? 'en' : 'zh'));
    }
  }

  void _schedule() {
    _timer?.cancel();
    _timer = Timer(_debounce, () => unawaited(flush()));
  }

  /// 立即落盘。只写「界面接管的字段」，其余字段原样保留。
  Future<void> flush() async {
    _timer?.cancel();
    _timer = null;
    final Map<String, Object?> patch = <String, Object?>{};
    for (final SmSection section in kSettingsSections) {
      for (final SmField field in section.fields) {
        if (_values.containsKey(field.key)) patch[field.key] = _values[field.key];
      }
    }
    if (_values.containsKey('scanDirs')) patch['scanDirs'] = _values['scanDirs'];
    if (_values.containsKey('desktopLyricsBounds')) {
      patch['desktopLyricsBounds'] = _values['desktopLyricsBounds'];
    }
    if (patch.isEmpty) return;
    store.merge(patch);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    super.dispose();
  }
}
