import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// 极简 JSON 文件持久化（对应桌面端的 JsonStore）。
///
/// 落在 应用支持目录/silvermoon/<fileName>，整对象读写 + 原子替换。
class JsonStore {
  JsonStore(this.fileName);

  final String fileName;

  File? _file;
  Map<String, dynamic>? _cache;

  Future<File> _resolve() async {
    final File? cached = _file;
    if (cached != null) return cached;
    final Directory base = await getApplicationSupportDirectory();
    final Directory dir = Directory(base.path + Platform.pathSeparator + 'silvermoon');
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    final File f = File(dir.path + Platform.pathSeparator + fileName);
    _file = f;
    return f;
  }

  /// 读整对象；文件不存在或损坏返回 null。
  Future<Map<String, dynamic>?> read() async {
    if (_cache != null) return _cache;
    try {
      final File f = await _resolve();
      if (!await f.exists()) return null;
      final String text = await f.readAsString();
      if (text.trim().isEmpty) return null;
      final Object? j = jsonDecode(text);
      if (j is Map) {
        final Map<String, dynamic> m = Map<String, dynamic>.from(j);
        _cache = m;
        return m;
      }
    } catch (_) {
      // 损坏文件直接忽略
    }
    return null;
  }

  /// 写整对象（先写临时文件再 rename，避免写一半掉电损坏）
  ///
  /// 写前会先把磁盘上的现有内容读回来合并。settings.json 还有第二个写入者：
  /// WebView 里 Vue 的那套设置（把整个设置对象存在单个 `settings` 键下，
  /// 见 ipc/store.ts 与 stores/settings.ts）。两边都是整份读写、各自还有内存
  /// 缓存，直接覆盖会把对方整个抹掉 —— 表现就是「设置改了一会儿又自己变回去」。
  /// 两边的顶层键不重叠（扁平键 vs `settings`），所以合并即可共存。
  Future<void> write(Map<String, dynamic> data) async {
    try {
      final File f = await _resolve();
      final Map<String, dynamic> merged = <String, dynamic>{};
      if (await f.exists()) {
        try {
          final Object? j = jsonDecode(await f.readAsString());
          if (j is Map) merged.addAll(Map<String, dynamic>.from(j));
        } catch (_) {
          // 读不动就当成空的，照常写下去
        }
      }
      merged.addAll(data);
      _cache = merged;
      final File tmp = File(f.path + '.tmp');
      await tmp.writeAsString(jsonEncode(merged), flush: true);
      if (await f.exists()) {
        await f.delete();
      }
      await tmp.rename(f.path);
    } catch (_) {
      // 忽略持久化失败，不影响播放
    }
  }

  Future<void> clear() async {
    _cache = null;
    try {
      final File f = await _resolve();
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }
}
