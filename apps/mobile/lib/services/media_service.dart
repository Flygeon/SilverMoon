import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';

/// 本地媒体类型。音乐不走这里（音乐由 WebView 里的 Vue 前端 + 桥接管），
/// 图片 / 视频 / 书籍三个页签用它。
enum MediaKind { image, video, book }

const Set<String> kImageExtensions = <String>{
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif',
  '.avif', '.jfif', '.tif', '.tiff',
};

const Set<String> kVideoExtensions = <String>{
  '.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.3gp',
  '.ts', '.mpg', '.mpeg', '.rmvb', '.rm', '.vob',
};

const Set<String> kBookExtensions = <String>{
  '.txt', '.epub', '.pdf', '.mobi', '.azw3', '.azw', '.fb2', '.md', '.html',
  '.htm', '.cbz', '.cbr',
};

extension MediaKindX on MediaKind {
  String get label {
    switch (this) {
      case MediaKind.image:
        return '图片';
      case MediaKind.video:
        return '视频';
      case MediaKind.book:
        return '书籍';
    }
  }

  Set<String> get extensions {
    switch (this) {
      case MediaKind.image:
        return kImageExtensions;
      case MediaKind.video:
        return kVideoExtensions;
      case MediaKind.book:
        return kBookExtensions;
    }
  }

  /// Android 侧要申请的运行时权限。书籍在 Android 13+ 没有对应的媒体权限，
  /// 只能尽力而为（读 Download/Documents 需要用户另外授权），这里返回 null。
  Permission? get androidPermission {
    switch (this) {
      case MediaKind.image:
        return Permission.photos;
      case MediaKind.video:
        return Permission.videos;
      case MediaKind.book:
        return Permission.storage;
    }
  }
}

/// 一个本地媒体文件。
@immutable
class MediaItem {
  const MediaItem({
    required this.path,
    required this.name,
    required this.kind,
    this.size = 0,
    this.modified,
  });

  final String path;
  final String name;
  final MediaKind kind;
  final int size;
  final DateTime? modified;

  /// 不带扩展名的主标题。
  String get title {
    final int dot = name.lastIndexOf('.');
    return dot > 0 ? name.substring(0, dot) : name;
  }

  String get extension {
    final int dot = name.lastIndexOf('.');
    return dot >= 0 ? name.substring(dot).toLowerCase() : '';
  }

  String get parentDir {
    final int i = path.lastIndexOf(RegExp(r'[/\\]'));
    return i > 0 ? path.substring(0, i) : '';
  }

  String get parentName {
    final String dir = parentDir;
    if (dir.isEmpty) return '';
    final List<String> parts = dir.split(RegExp(r'[/\\]'));
    return parts.isEmpty ? dir : parts.last;
  }

  String get sizeLabel {
    if (size <= 0) return '';
    const List<String> units = <String>['B', 'KB', 'MB', 'GB', 'TB'];
    double v = size.toDouble();
    int i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return '${v.toStringAsFixed(v >= 100 || i == 0 ? 0 : 1)} ${units[i]}';
  }

  @override
  bool operator ==(Object other) =>
      other is MediaItem && other.path == path && other.kind == kind;

  @override
  int get hashCode => Object.hash(path, kind);
}

/// 本地媒体扫描。刻意做成「遍历目录 + 扩展名过滤」的朴素实现：
/// 音乐曲库用的是同一套策略，行为一致，也不需要额外的原生插件。
class MediaService {
  /// 申请该类型所需的运行时权限，返回是否可用。
  /// iOS 上图片/视频走相册权限（这里不申请，直接读 App 沙盒目录），返回 true。
  Future<bool> ensurePermission(MediaKind kind) async {
    if (!Platform.isAndroid) return true;
    final Permission? p = kind.androidPermission;
    if (p == null) return true;
    try {
      PermissionStatus status = await p.status;
      if (status.isGranted || status.isLimited) return true;
      status = await p.request();
      if (status.isGranted || status.isLimited) return true;
      // Android 13+ 的 photos/videos 申请不到时，回退到旧版存储权限
      final PermissionStatus legacy = await Permission.storage.request();
      return legacy.isGranted || legacy.isLimited;
    } catch (e) {
      debugPrint('media 权限申请失败: $e');
      return false;
    }
  }

  /// 该类型默认扫描的根目录。
  Future<List<String>> defaultRoots(MediaKind kind) async {
    final List<String> roots = <String>[];
    if (Platform.isAndroid) {
      const String base = '/storage/emulated/0';
      switch (kind) {
        case MediaKind.image:
          roots.addAll(<String>[
            '$base/DCIM',
            '$base/Pictures',
            '$base/Download',
            '$base/Screenshots',
            '$base/Android/media',
            '$base/Netease',
          ]);
          break;
        case MediaKind.video:
          roots.addAll(<String>[
            '$base/DCIM',
            '$base/Movies',
            '$base/Download',
            '$base/Videos',
            '$base/Android/media',
          ]);
          break;
        case MediaKind.book:
          roots.addAll(<String>[
            '$base/Books',
            '$base/Documents',
            '$base/Download',
            '$base/Android/media',
          ]);
          break;
      }
    }
    // 两端都加上 App 自己的文档目录（iOS 上这是唯一可读的位置）
    try {
      final Directory docs = await getApplicationDocumentsDirectory();
      roots.add(docs.path);
      final Directory? ext = await getExternalStorageDirectory();
      if (ext != null) roots.add(ext.path);
    } catch (_) {
      // 拿不到就跳过
    }
    return roots;
  }

  /// 扫描。结果按修改时间倒序。
  Future<List<MediaItem>> scan(
    MediaKind kind, {
    List<String>? roots,
    int maxFiles = 20000,
  }) async {
    final List<String> dirs = roots ?? await defaultRoots(kind);
    final Set<String> exts = kind.extensions;
    final List<MediaItem> out = <MediaItem>[];
    final Set<String> seen = <String>{};

    for (final String root in dirs) {
      if (out.length >= maxFiles) break;
      final Directory dir = Directory(root);
      bool exists = false;
      try {
        exists = await dir.exists();
      } catch (_) {
        exists = false;
      }
      if (!exists) continue;

      try {
        await for (final FileSystemEntity entity
            in dir.list(recursive: true, followLinks: false)) {
          if (out.length >= maxFiles) break;
          if (entity is! File) continue;
          final String path = entity.path;
          final String lower = path.toLowerCase();
          // 跳过隐藏目录与缓存
          if (lower.contains('/.') || lower.contains('/android/data/')) continue;
          final int dot = lower.lastIndexOf('.');
          if (dot < 0) continue;
          if (!exts.contains(lower.substring(dot))) continue;
          if (!seen.add(path)) continue;

          int size = 0;
          DateTime? modified;
          try {
            final FileStat stat = await entity.stat();
            size = stat.size;
            modified = stat.modified;
          } catch (_) {
            // 单个文件拿不到 stat 就跳过，不影响整体
          }
          if (size <= 0) continue;

          final int slash = path.lastIndexOf(RegExp(r'[/\\]'));
          out.add(MediaItem(
            path: path,
            name: slash >= 0 ? path.substring(slash + 1) : path,
            kind: kind,
            size: size,
            modified: modified,
          ));
        }
      } catch (e) {
        // 权限不足 / 目录不可读：跳过这个根目录
        debugPrint('media 扫描 $root 失败: $e');
      }
    }

    out.sort((MediaItem a, MediaItem b) {
      final DateTime? ma = a.modified;
      final DateTime? mb = b.modified;
      if (ma == null && mb == null) return a.name.compareTo(b.name);
      if (ma == null) return 1;
      if (mb == null) return -1;
      return mb.compareTo(ma);
    });
    return out;
  }
}
