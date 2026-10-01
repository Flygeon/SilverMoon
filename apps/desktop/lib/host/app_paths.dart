import 'dart:io';

/// 宿主侧路径解析。
///
/// 数值必须与 Rust 侧 `app_data_dir()`、Electron `electron/config.ts` 完全一致，
/// 否则会出现「设置读到了、库却打在另一个目录」这类静默错位：
///   * 数据目录 = `<APPDATA>/<identifier>`
///   * 缓存目录 = `<LOCALAPPDATA>/<identifier>/cache`
///   * 日志目录 = `<APPDATA>/<identifier>/logs`
///
/// `identifier` 的唯一真源是 `backend/silvermoon.config.json`（当前 `cn.cool.silvermoon`），
/// 不要在这里另写字面量。
class HostPaths {
  HostPaths(this.identifier)
      : appDataRoot = Platform.environment['APPDATA'] ?? '',
        localAppDataRoot = Platform.environment['LOCALAPPDATA'] ?? '';

  /// 便于单测注入根目录。
  const HostPaths.forRoots({
    required this.identifier,
    required this.appDataRoot,
    required this.localAppDataRoot,
  });

  final String identifier;
  final String appDataRoot;
  final String localAppDataRoot;

  /// 与 Rust `app_data_dir()` 同值：库、设置、日志、登录态都在这里。
  String get dataDir => _join(appDataRoot, identifier);

  /// 缓存根（Electron config.ts 的 cacheDir = localAppData/identifier/cache）。
  String get cacheDir => _join(_join(localAppDataRoot, identifier), 'cache');

  String get logDir => _join(dataDir, 'logs');

  /// 媒体库 SQLite（Rust 侧建库、宿主只判断是否存在）。
  String get indexPath => _join(dataDir, 'library.db');

  String get settingsPath => _join(dataDir, 'settings.json');

  /// 旧项目 LumiLuna 的数据目录。只读，仅用于首次整目录迁移。
  String legacyDataDir(String legacyIdentifier) => _join(appDataRoot, legacyIdentifier);

  void ensureDataDirs() {
    Directory(dataDir).createSync(recursive: true);
    Directory(cacheDir).createSync(recursive: true);
    Directory(logDir).createSync(recursive: true);
  }
}

String _join(String root, String name) {
  if (root.isEmpty) return name;
  final String sep = Platform.pathSeparator;
  return root.endsWith(sep) ? root + name : root + sep + name;
}
