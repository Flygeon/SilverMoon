import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../services/media_service.dart';

/// 网格缩略图。
///
/// 两类来源：
/// - 文件系统条目：直接 Image.file
/// - iOS 相册资产：缩略图由 photo_manager 现出（Image.memory）
///
/// 缩略图只在 initState 里取一次并缓存，避免每次 rebuild 都重新解码。
class MediaThumb extends StatefulWidget {
  const MediaThumb({
    super.key,
    required this.item,
    this.fit = BoxFit.cover,
    this.thumbSize = 320,
  });

  final MediaItem item;
  final BoxFit fit;
  final int thumbSize;

  @override
  State<MediaThumb> createState() => _MediaThumbState();
}

class _MediaThumbState extends State<MediaThumb> {
  Uint8List? _bytes;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant MediaThumb old) {
    super.didUpdateWidget(old);
    if (old.item.path != widget.item.path) {
      _bytes = null;
      _done = false;
      _load();
    }
  }

  /// 相册资产（图片/视频）和文件系统里的视频都要异步出缩略图；
  /// 只有文件系统里的图片能直接 Image.file。
  bool get _needsBytes =>
      widget.item.isAsset || widget.item.kind == MediaKind.video;

  Future<void> _load() async {
    if (!_needsBytes) {
      if (mounted) setState(() => _done = true);
      return;
    }
    final Uint8List? bytes =
        await MediaService.thumbBytes(widget.item, widget.thumbSize);
    if (!mounted) return;
    setState(() {
      _bytes = bytes;
      _done = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final Uint8List? bytes = _bytes;
    if (bytes != null) {
      return Image.memory(bytes, fit: widget.fit, gaplessPlayback: true);
    }
    if (!_needsBytes) {
      return Image.file(
        File(widget.item.path),
        fit: widget.fit,
        cacheWidth: widget.thumbSize,
        errorBuilder: (_, __, ___) => _broken(context),
      );
    }
    if (!_done) {
      return Container(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      );
    }
    return _broken(context);
  }

  Widget _broken(BuildContext context) => Container(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        child: const Icon(Icons.broken_image_outlined, size: 22),
      );
}

/// 全屏大图。相册资产会先落盘成文件再交给 Image.file
/// （iCloud 上的原图在这一步下载，所以要有 loading 态）。
class MediaFullImage extends StatefulWidget {
  const MediaFullImage({super.key, required this.item});

  final MediaItem item;

  @override
  State<MediaFullImage> createState() => _MediaFullImageState();
}

class _MediaFullImageState extends State<MediaFullImage> {
  File? _file;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant MediaFullImage old) {
    super.didUpdateWidget(old);
    if (old.item.path != widget.item.path) {
      _file = null;
      _done = false;
      _load();
    }
  }

  Future<void> _load() async {
    final File? f = await MediaService.materializeFile(widget.item);
    if (!mounted) return;
    setState(() {
      _file = f;
      _done = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final File? f = _file;
    if (f != null) {
      return Image.file(
        f,
        fit: BoxFit.contain,
        errorBuilder: (_, __, ___) => const Center(
          child: Icon(Icons.broken_image_outlined,
              color: Colors.white38, size: 48),
        ),
      );
    }
    if (!_done) {
      return const Center(
        child: SizedBox(
          width: 28,
          height: 28,
          child: CircularProgressIndicator(
              color: Colors.white38, strokeWidth: 2),
        ),
      );
    }
    return const Center(
      child: Icon(Icons.broken_image_outlined, color: Colors.white38, size: 48),
    );
  }
}
