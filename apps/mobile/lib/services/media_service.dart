import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:video_thumbnail/video_thumbnail.dart';

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
    this.assetId,
  });

  /// 文件系统路径。相册资产没有路径，这里放的是资产 id（保证 == / hashCode 仍可用）。
  final String path;
  final String name;
  final MediaKind kind;
  final int size;
  final DateTime? modified;

  /// iOS 相册资产 id。非空表示这条记录来自系统相册，需要走
  /// [MediaService.materializeFile] / [MediaService.thumbnailBytes] 才能拿到内容。
  final String? assetId;

  bool get isAsset => assetId != null;

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
  ///
  /// iOS：图片/视频要的是相册权限，由 photo_manager 自己弹系统授权框
  ///      （见 _scanPhotoLibrary），这里不重复申请。
  ///      书籍读的是 App 文档目录（Info.plist 已开 UIFileSharingEnabled），无需权限。
  Future<bool> ensurePermission(MediaKind kind) async {
    if (Platform.isIOS) return true;
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

    // iOS 的图片/视频不在文件系统里，只能从系统相册取。
    // Android 继续走目录扫描：那边 DCIM/Pictures 是真实可读的路径，
    // 再叠一层相册枚举只会出重复项。
    if (Platform.isIOS && kind != MediaKind.book) {
      out.addAll(await _scanPhotoLibrary(kind, maxFiles));
    }

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

  // ------------------------------------------------------------------ 系统相册

  static String _two(int v) => v < 10 ? '0$v' : '$v';

  /// 从系统相册读图片/视频。
  ///
  /// 刻意**只取 id 和元信息，不落盘**：iOS 上 AssetEntity.file 会把原图
  /// 复制一份到临时目录，几千张照片就是几个 GB。真正需要文件时再由
  /// [materializeFile] 按需取，缩略图则由 [thumbnailBytes] 现出。
  Future<List<MediaItem>> _scanPhotoLibrary(MediaKind kind, int maxFiles) async {
    final RequestType type =
        kind == MediaKind.video ? RequestType.video : RequestType.image;
    final List<MediaItem> out = <MediaItem>[];
    try {
      final PermissionState ps = await PhotoManager.requestPermissionExtend();
      if (!ps.isAuth) {
        debugPrint('相册权限未授予: $ps');
        return out;
      }
      final List<AssetPathEntity> albums =
          await PhotoManager.getAssetPathList(type: type, onlyAll: true);
      if (albums.isEmpty) return out;
      final AssetPathEntity all = albums.first;
      final int total = await all.assetCountAsync;
      if (total <= 0) return out;
      final int take = total > maxFiles ? maxFiles : total;
      final List<AssetEntity> assets =
          await all.getAssetListRange(start: 0, end: take);
      final String ext = kind == MediaKind.video ? '.mp4' : '.jpg';
      for (final AssetEntity a in assets) {
        final String? raw = a.title;
        final DateTime d = a.createDateTime;
        final String fallback = 'IMG_${d.year}${_two(d.month)}${_two(d.day)}_'
            '${_two(d.hour)}${_two(d.minute)}${_two(d.second)}$ext';
        out.add(MediaItem(
          path: a.id,
          assetId: a.id,
          name: (raw != null && raw.trim().isNotEmpty) ? raw.trim() : fallback,
          kind: kind,
          modified: d,
        ));
      }
    } catch (e) {
      debugPrint('相册扫描失败: $e');
    }
    return out;
  }

  /// 把 MediaItem 解析成一个真实可读的文件。
  ///
  /// - 文件系统条目：直接 File(path)
  /// - 相册资产：交给 photo_manager 落盘（iCloud 上的资产会先下载）
  static Future<File?> materializeFile(MediaItem item) async {
    final String? id = item.assetId;
    if (id == null) return File(item.path);
    try {
      final AssetEntity? asset = await AssetEntity.fromId(id);
      return await asset?.file;
    } catch (e) {
      debugPrint('相册资产落盘失败 $id: $e');
      return null;
    }
  }

  /// 缩略图内存缓存。列表滚动时会反复重建，视频抽帧尤其贵。
  static final Map<String, Uint8List> _thumbCache = <String, Uint8List>{};

  /// 相册资产的缩略图（图片和视频都能出）。
  /// 文件系统条目返回 null（调用方直接用 Image.file）。
  static Future<Uint8List?> thumbnailBytes(MediaItem item, int size) async {
    final String? id = item.assetId;
    if (id == null) return null;
    final String key = 'a:$id:$size';
    final Uint8List? hit = _thumbCache[key];
    if (hit != null) return hit;
    try {
      final AssetEntity? asset = await AssetEntity.fromId(id);
      final Uint8List? bytes =
          await asset?.thumbnailDataWithSize(ThumbnailSize(size, size));
      if (bytes != null) _thumbCache[key] = bytes;
      return bytes;
    } catch (e) {
      debugPrint('相册缩略图失败 $id: $e');
      return null;
    }
  }

  /// 缩略图总入口：相册资产走 photo_manager，文件系统里的视频抽帧，
  /// 文件系统里的图片交给 Image.file（返回 null）。
  static Future<Uint8List?> thumbBytes(MediaItem item, int size) async {
    if (item.assetId != null) return thumbnailBytes(item, size);
    if (item.kind != MediaKind.video) return null;
    final String key = 'v:${item.path}:$size';
    final Uint8List? hit = _thumbCache[key];
    if (hit != null) return hit;
    try {
      final Uint8List? bytes = await VideoThumbnail.thumbnailData(
        video: item.path,
        imageFormat: ImageFormat.JPEG,
        maxWidth: size,
        quality: 70,
      );
      if (bytes != null) _thumbCache[key] = bytes;
      return bytes;
    } catch (e) {
      debugPrint('视频缩略图失败 ${item.path}: $e');
      return null;
    }
  }

  /// 切换媒体库/刷新时清掉缩略图缓存。
  static void clearThumbCache() => _thumbCache.clear();
}
