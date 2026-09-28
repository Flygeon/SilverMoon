import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../models/track.dart';
import 'library_service.dart';

/// 封面 URI 解析：
/// - 在线曲目直接用封面 URL（通知栏/锁屏由系统加载）
/// - 本地曲目把内嵌封面抽到临时目录并返回 file:// URI
class ArtworkService {
  ArtworkService._();

  static final Map<String, Uri?> _cache = <String, Uri?>{};

  static Future<Uri?> artUri(Track t) async {
    final String key = t.id;
    if (_cache.containsKey(key)) return _cache[key];
    Uri? uri;
    try {
      if (t.coverUrl != null && t.coverUrl!.trim().isNotEmpty) {
        uri = Uri.tryParse(t.coverUrl!.trim());
      } else if (t.filePath != null) {
        uri = await _extractEmbedded(t.filePath!);
      }
    } catch (_) {
      uri = null;
    }
    _cache[key] = uri;
    return uri;
  }

  static Future<Uri?> _extractEmbedded(String filePath) async {
    try {
      final Directory dir = await getTemporaryDirectory();
      final String hash = md5.convert(utf8.encode(filePath)).toString();
      final File f =
          File(dir.path + Platform.pathSeparator + 'sm_art_' + hash + '.img');
      if (await f.exists() && await f.length() > 0) return Uri.file(f.path);
      final Map<String, dynamic>? m =
          await compute(readArtworkInIsolate, filePath);
      if (m == null) return null;
      final Object? bytes = m['bytes'];
      if (bytes is! Uint8List || bytes.isEmpty) return null;
      await f.writeAsBytes(bytes, flush: true);
      return Uri.file(f.path);
    } catch (_) {
      return null;
    }
  }

  static void clear() => _cache.clear();
}
