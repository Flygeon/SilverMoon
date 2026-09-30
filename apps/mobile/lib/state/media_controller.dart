import 'package:flutter/foundation.dart';

import '../services/media_service.dart';

/// 图片 / 视频 / 书籍三个页签的扫描结果。
///
/// 音乐不走这里：音乐页签是原生实现，见 ui/music_page.dart。
class MediaController extends ChangeNotifier {
  MediaController(this.service);

  final MediaService service;

  final Map<MediaKind, List<MediaItem>> _items = <MediaKind, List<MediaItem>>{
    MediaKind.image: <MediaItem>[],
    MediaKind.video: <MediaItem>[],
    MediaKind.book: <MediaItem>[],
  };
  final Map<MediaKind, bool> _loading = <MediaKind, bool>{};
  final Map<MediaKind, String?> _errors = <MediaKind, String?>{};
  final Map<MediaKind, bool> _loaded = <MediaKind, bool>{};

  List<MediaItem> items(MediaKind kind) => _items[kind] ?? const <MediaItem>[];

  bool isLoading(MediaKind kind) => _loading[kind] ?? false;

  bool hasLoaded(MediaKind kind) => _loaded[kind] ?? false;

  String? errorOf(MediaKind kind) => _errors[kind];

  /// 首次进入页签时调用；已加载过则直接返回。
  Future<void> ensureLoaded(MediaKind kind) async {
    if (hasLoaded(kind) || isLoading(kind)) return;
    await refresh(kind);
  }

  Future<void> refresh(MediaKind kind) async {
    if (isLoading(kind)) return;
    _loading[kind] = true;
    _errors[kind] = null;
    notifyListeners();
    try {
      final bool granted = await service.ensurePermission(kind);
      if (!granted) {
        _items[kind] = <MediaItem>[];
        _errors[kind] = '没有拿到读取权限，去系统设置里允许后下拉重试';
      } else {
        _items[kind] = await service.scan(kind);
        _errors[kind] = null;
      }
      _loaded[kind] = true;
    } catch (e) {
      _errors[kind] = '扫描失败：$e';
    } finally {
      _loading[kind] = false;
      notifyListeners();
    }
  }
}
