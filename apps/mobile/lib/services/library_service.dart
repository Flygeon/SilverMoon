import 'dart:io';

import 'package:audio_metadata_reader/audio_metadata_reader.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';

import '../models/track.dart';
import 'json_store.dart';

/// Android 常见音乐目录（与桌面端 / 参考实现对齐）
const List<String> kAndroidScanDirs = <String>[
  '/storage/emulated/0/Music',
  '/storage/emulated/0/Download',
  '/storage/emulated/0/Netease/CloudMusic/Music',
  '/storage/emulated/0/qqmusic/song',
  '/storage/emulated/0/kugou/down_data',
  '/storage/emulated/0/kugou/down_kg',
];

/// 支持的音频扩展名（纯音频，不含视频容器）
const Set<String> kAudioExtensions = <String>{
  '.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.ape', '.wma',
  '.aif', '.aiff', '.aifc', '.mp4a', '.mka',
};

/// Isolate 入口：批量读标签。返回可序列化 List<Map>。
List<Map<String, dynamic>> readAudioMetadataInIsolate(List<String> filePaths) {
  final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
  for (final String path in filePaths) {
    try {
      final File f = File(path);
      if (!f.existsSync()) continue;
      final AudioMetadata meta = readMetadata(f, getImage: false);
      final String fileName = path.split(Platform.pathSeparator).last;
      final int dot = fileName.lastIndexOf('.');
      out.add(<String, dynamic>{
        'filePath': path,
        'title': (meta.title ?? '').trim().isEmpty
            ? (dot > 0 ? fileName.substring(0, dot) : fileName)
            : meta.title,
        'artist': meta.artist ?? '',
        'album': meta.album ?? '',
        'durationMs': meta.duration?.inMilliseconds ?? 0,
        'bitrate': meta.bitrate ?? 0,
      });
    } catch (e) {
      debugPrint('[Library] 跳过无法解析的文件: ' + path);
    }
  }
  return out;
}

/// Isolate 入口：读内嵌封面字节
Map<String, dynamic>? readArtworkInIsolate(String filePath) {
  try {
    final File f = File(filePath);
    if (!f.existsSync()) return null;
    final AudioMetadata meta = readMetadata(f, getImage: true);
    if (meta.pictures.isNotEmpty) {
      final Picture p = meta.pictures.firstWhere(
        (Picture e) => e.pictureType == PictureType.coverFront,
        orElse: () => meta.pictures.first,
      );
      return <String, dynamic>{'bytes': p.bytes};
    }
  } catch (_) {}
  return null;
}

/// 递归收集音频文件路径
List<String> collectAudioFiles(List<String> roots, {double minFileSizeMb = 0}) {
  final List<String> out = <String>[];
  final Set<String> seen = <String>{};
  final int minBytes = (minFileSizeMb * 1024 * 1024).round();
  for (final String root in roots) {
    try {
      final Directory dir = Directory(root);
      if (!dir.existsSync()) continue;
      for (final FileSystemEntity e in dir.listSync(recursive: true, followLinks: false)) {
        if (e is! File) continue;
        final String path = e.path;
        final int dot = path.lastIndexOf('.');
        if (dot <= 0) continue;
        final String ext = path.substring(dot).toLowerCase();
        if (!kAudioExtensions.contains(ext)) continue;
        if (minBytes > 0) {
          try {
            if (e.lengthSync() < minBytes) continue;
          } catch (_) {}
        }
        if (seen.add(path)) out.add(path);
      }
    } catch (e) {
      debugPrint('[Library] 目录不可访问: ' + root);
    }
  }
  return out;
}

/// 本地媒体库：扫描 + 持久化
class LibraryService {
  LibraryService({JsonStore? store}) : _store = store ?? JsonStore('library.json');

  final JsonStore _store;

  List<Track> _tracks = <Track>[];

  List<Track> get tracks => _tracks;

  /// Android 需要读媒体权限；iOS 只扫 App 沙盒目录，无需权限。
  Future<bool> ensurePermission() async {
    if (!Platform.isAndroid) return true;
    try {
      final Permission p = Permission.audio;
      PermissionStatus st = await p.status;
      if (st.isGranted) return true;
      st = await p.request();
      if (st.isGranted) return true;
      final Permission legacy = Permission.storage;
      if (await legacy.status.isGranted) return true;
      final PermissionStatus st2 = await legacy.request();
      return st2.isGranted;
    } catch (_) {
      return false;
    }
  }

  Future<List<String>> defaultScanDirs() async {
    if (Platform.isAndroid) return kAndroidScanDirs;
    try {
      final Directory doc = await getApplicationDocumentsDirectory();
      return <String>[doc.path];
    } catch (_) {
      return const <String>[];
    }
  }

  Future<List<Track>> load() async {
    final Map<String, dynamic>? j = await _store.read();
    final List<dynamic> raw = (j?['tracks'] as List<dynamic>?) ?? const <dynamic>[];
    _tracks = raw
        .whereType<Map>()
        .map((Map e) => Track.fromJson(Map<String, dynamic>.from(e)))
        .toList();
    return _tracks;
  }

  Future<void> persist() async {
    await _store.write(<String, dynamic>{
      'tracks': _tracks.map((Track t) => t.toJson()).toList(),
      'scannedAt': DateTime.now().millisecondsSinceEpoch,
    });
  }

  /// 扫描给定目录
  Future<List<Track>> scan(
    List<String> dirs, {
    double minFileSizeMb = 0,
    void Function(int found, int total)? onProgress,
  }) async {
    final List<String> paths = collectAudioFiles(dirs, minFileSizeMb: minFileSizeMb);
    if (paths.isEmpty) {
      _tracks = <Track>[];
      await persist();
      return _tracks;
    }
    final List<Map<String, dynamic>> metas =
        await compute(readAudioMetadataInIsolate, paths);
    final List<Track> list = <Track>[];
    for (final Map<String, dynamic> m in metas) {
      final String path = (m['filePath'] ?? '').toString();
      final int ms = (m['durationMs'] as num?)?.toInt() ?? 0;
      final int slash = path.lastIndexOf(Platform.pathSeparator);
      list.add(Track(
        id: 'local:' + path,
        title: (m['title'] ?? '').toString(),
        artist: (m['artist'] ?? '').toString(),
        album: (m['album'] ?? '').toString(),
        duration: ms > 0 ? Duration(milliseconds: ms) : null,
        filePath: path,
        bitrate: (m['bitrate'] as num?)?.toInt(),
        folder: slash > 0 ? path.substring(0, slash) : null,
        addedAt: DateTime.now(),
      ));
    }
    _tracks = list;
    onProgress?.call(list.length, paths.length);
    await persist();
    return _tracks;
  }

  void setTracks(List<Track> list) {
    _tracks = list;
  }
}
