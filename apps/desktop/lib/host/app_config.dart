import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 应用元信息，唯一真源是 `backend/silvermoon.config.json`。
///
/// 同一个文件被三方读取，必须保持单一真源：
///   * Rust 侧 `generate_context!` 在**编译期**读它；
///   * Electron 主进程在**运行期**读它；
///   * Flutter 宿主把它作为 asset 打进包，在**运行期**读它。
/// 任何一侧改了字面量都会让窗口标题、identifier、数据目录互相对不上。
class AppConfig {
  const AppConfig({
    required this.productName,
    required this.identifier,
    required this.version,
    required this.windowTitle,
    required this.windowWidth,
    required this.windowHeight,
    required this.windowMinWidth,
    required this.windowMinHeight,
    required this.windowDecorations,
    required this.windowCenter,
    required this.windowResizable,
    required this.sidecarBinary,
    required this.sidecarDevBinary,
    required this.legacyIdentifier,
  });

  factory AppConfig.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> window = _map(json['window']);
    final Map<String, Object?> sidecar = _map(json['sidecar']);
    final Map<String, Object?> migration = _map(json['migration']);
    return AppConfig(
      productName: _str(json['productName']) ?? 'SilverMoon',
      identifier: _str(json['identifier']) ?? 'cn.cool.silvermoon',
      version: _str(json['version']) ?? '0.0.0',
      windowTitle: _str(window['title']) ?? 'SilverMoon',
      windowWidth: _num(window['width']) ?? 1280,
      windowHeight: _num(window['height']) ?? 800,
      windowMinWidth: _num(window['minWidth']) ?? 900,
      windowMinHeight: _num(window['minHeight']) ?? 600,
      windowDecorations: window['decorations'] == true,
      windowCenter: window['center'] != false,
      windowResizable: window['resizable'] != false,
      sidecarBinary: _str(sidecar['binary']) ?? 'silvermoon-server',
      sidecarDevBinary: _str(sidecar['devBinary']) ?? 'silvermoon',
      legacyIdentifier: _str(migration['legacyIdentifier']) ?? '',
    );
  }

  /// 从 asset 读取（pubspec 里声明了 `backend/silvermoon.config.json`）。
  static Future<AppConfig> load() async {
    try {
      final String raw = await rootBundle.loadString('backend/silvermoon.config.json');
      final Object? decoded = jsonDecode(raw);
      if (decoded is! Map) {
        throw StateError('silvermoon.config.json 不是 JSON 对象');
      }
      return AppConfig.fromJson(decoded.cast<String, Object?>());
    } catch (error) {
      // 读不到就退回内置默认值，但必须大声留痕：identifier 一旦不对，
      // 数据目录会指到别处，属于要立刻发现的问题。
      debugPrint('[config] 读取 silvermoon.config.json 失败，退回内置默认值：' + error.toString());
      return fallback;
    }
  }

  /// 内置兜底（仅 asset 缺失时使用；正常路径永远走文件，避免两处真源漂移）。
  static const AppConfig fallback = AppConfig(
    productName: 'SilverMoon',
    identifier: 'cn.cool.silvermoon',
    version: '0.0.0',
    windowTitle: 'SilverMoon',
    windowWidth: 1280,
    windowHeight: 800,
    windowMinWidth: 900,
    windowMinHeight: 600,
    windowDecorations: false,
    windowCenter: true,
    windowResizable: true,
    sidecarBinary: 'silvermoon-server',
    sidecarDevBinary: 'silvermoon',
    legacyIdentifier: 'cn.cool.lumiluna',
  );

  final String productName;
  final String identifier;
  final String version;
  final String windowTitle;
  final double windowWidth;
  final double windowHeight;
  final double windowMinWidth;
  final double windowMinHeight;
  final bool windowDecorations;
  final bool windowCenter;
  final bool windowResizable;

  /// 打包后的后端可执行文件名（不含扩展名）：`silvermoon-server`。
  final String sidecarBinary;

  /// 开发态 cargo 产物名：`silvermoon`。
  final String sidecarDevBinary;

  /// 旧项目 LumiLuna 的 identifier，首次启动整目录迁移用。
  final String legacyIdentifier;
}

Map<String, Object?> _map(Object? value) {
  if (value is Map) return value.cast<String, Object?>();
  return const <String, Object?>{};
}

String? _str(Object? value) => value is String ? value : null;

double? _num(Object? value) {
  if (value is num) return value.toDouble();
  return null;
}
