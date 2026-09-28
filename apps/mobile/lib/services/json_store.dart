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
  Future<void> write(Map<String, dynamic> data) async {
    _cache = data;
    try {
      final File f = await _resolve();
      final File tmp = File(f.path + '.tmp');
      await tmp.writeAsString(jsonEncode(data), flush: true);
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
