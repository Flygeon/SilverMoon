import 'json_store.dart';

/// `settings.json` 的读写门面。
///
/// 结构由 Electron 版固定，**键名不能改**，否则读不到既有用户数据：
///   settings.json = { "settings": { ...约 75 个字段... } }
/// 整份设置挂在 `"settings"` 键下（settings.ts 的 store.set("settings", payload)），
/// `scanDirs` / `minFileSizeMb` / `ffmpegDir` / `webdav*` 等都是它内部的字段。
class SettingsStore {
  SettingsStore(this._store);

  final JsonStore _store;

  static const String fileName = 'settings.json';
  static const String key = 'settings';

  /// 读出设置对象；文件不存在或结构不对时返回空表。
  Map<String, Object?> read() {
    final Object? value = _store.read(fileName, key);
    // 返回副本：merge 会在返回的 map 上 addAll，直接给视图会把改动写回 store 内部，
    // 且 Map.cast 的视图在 jsonEncode 时的行为不值得依赖。
    return value is Map
        ? Map<String, Object?>.from(value)
        : <String, Object?>{};
  }

  /// 合并写入：**只覆盖给定字段**，不整份重写。
  ///
  /// Electron 版是渲染层把 75 个字段全量重写；Flutter 侧在设置页接管之前只动
  /// 自己负责的字段，避免把尚未实现的字段（以及今后新增的字段）抹掉。
  void merge(Map<String, Object?> patch, {bool persist = true}) {
    final Map<String, Object?> data = read();
    data.addAll(patch);
    _store.write(fileName, key, data);
    if (persist) _store.save(fileName);
  }

  /// 已保存的扫描目录（去重前的原始顺序）。
  List<String> scanDirs() {
    final Object? value = read()['scanDirs'];
    if (value is! List) return <String>[];
    return value
        .whereType<String>()
        .where((String dir) => dir.trim().isNotEmpty)
        .toList();
  }

  /// 追加一个扫描目录（已存在则跳过）并立即落盘，下次启动不必重新添加。
  void addScanDir(String dir) {
    if (dir.trim().isEmpty) return;
    final List<String> dirs = scanDirs();
    if (dirs.contains(dir)) return;
    merge(<String, Object?>{'scanDirs': <String>[...dirs, dir]});
  }
}
