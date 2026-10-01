import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../host/host_controller.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import '../library/library_api.dart';
import '../library/media_entry.dart';

/// /images —— 图片库（P0 验收页：列出媒体库文件与缩略图）。
///
/// 数据面完全走 Rust。两条取缩略图路径必须区分开，这是大图库不卡的关键：
///   1. **缓存命中**：`list_files` 直接把 `thumbPath` 带回来，命令数为 0；
///   2. **未命中**：只把缺的 id 通过 `get_thumbnails` 一次批量补齐（同下标对应）。
/// 逐张调 `get_thumbnail` 会让 30 张卡片变成 30 次往返，禁止这么写。
class ImagesPage extends StatefulWidget {
  const ImagesPage({super.key});

  @override
  State<ImagesPage> createState() => _ImagesPageState();
}

class _ImagesPageState extends State<ImagesPage> {
  static const int _pageSize = 200;

  final Map<String, String> _thumbs = <String, String>{};
  List<MediaEntry> _entries = <MediaEntry>[];
  bool _loading = false;
  bool _loadedOnce = false;
  bool _scanning = false;
  String? _error;
  int _total = 0;
  ScanJobInfo? _scan;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final HostController host = context.watch<HostController>();
    if (host.isReady && !_loadedOnce) {
      _loadedOnce = true;
      WidgetsBinding.instance.addPostFrameCallback((Duration _) {
        if (mounted) unawaited(_load(reset: true));
      });
    }
  }

  LibraryApi? get _api => context.read<HostController>().library;

  Future<void> _load({required bool reset}) async {
    final LibraryApi? api = _api;
    if (api == null || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<MediaEntry> page = await api.listFiles(ListQuery(
        type: 'image',
        sortBy: 'mtime',
        desc: true,
        limit: _pageSize,
        offset: reset ? 0 : _entries.length,
      ));
      final int total = await api.countFiles(const ListQuery(type: 'image'));
      await _fillThumbs(api, page);
      if (!mounted) return;
      setState(() {
        _entries = reset ? page : <MediaEntry>[..._entries, ...page];
        _total = total;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 只为缓存未命中的条目发批量请求。
  Future<void> _fillThumbs(LibraryApi api, List<MediaEntry> entries) async {
    final List<String> missing = <String>[];
    for (final MediaEntry entry in entries) {
      final String? cached = entry.thumbPath;
      if (cached != null && cached.isNotEmpty) {
        _thumbs[entry.id] = cached;
      } else if (!_thumbs.containsKey(entry.id)) {
        missing.add(entry.id);
      }
    }
    if (missing.isEmpty) return;
    final List<String?> paths = await api.thumbnails(missing, size: 320);
    for (int i = 0; i < missing.length && i < paths.length; i++) {
      final String? path = paths[i];
      if (path != null && path.isNotEmpty) _thumbs[missing[i]] = path;
    }
  }

  Future<void> _addFolderAndScan() async {
    final LibraryApi? api = _api;
    if (api == null) return;
    final String? dir = await getDirectoryPath(
      confirmButtonText: context.read<AppState>().strings.t('images.addFolder'),
    );
    if (dir == null || !mounted) return;
    setState(() {
      _scanning = true;
      _error = null;
      _scan = null;
    });
    try {
      final String jobId = await api.scanStart(dirs: <String>[dir]);
      // P0 用轮询取进度；P1 接上 SSE 的 scan:progress 事件后改为事件驱动。
      while (mounted) {
        final ScanJobInfo? info = await api.scanStatus(jobId);
        if (!mounted) return;
        setState(() => _scan = info);
        if (info == null || info.isFinished) break;
        await Future<void>.delayed(const Duration(milliseconds: 400));
      }
      await _load(reset: true);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(sm),
        if (_scanning) _scanLine(sm),
        if (_error != null) _errorLine(sm),
        Expanded(child: _body(host, sm)),
      ],
    );
  }

  Widget _header(SmStrings sm) {
    final ColorScheme scheme = context.scheme;
    final bool hasMore = _entries.length < _total;
    return Padding(
      padding: const EdgeInsets.only(
        left: SM.contentPad,
        right: SM.space200,
        top: SM.space400,
        bottom: SM.space200,
      ),
      child: Row(
        children: <Widget>[
          Text(
            sm.t('page.images.title'),
            style: SmText.titleLarge.copyWith(color: scheme.onSurface),
          ),
          const SizedBox(width: SM.space300),
          if (_total > 0)
            Text(
              _total.toString() + ' ' + sm.t('images.total'),
              style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
            ),
          const Spacer(),
          if (hasMore && !_loading)
            TextButton(
              onPressed: () => unawaited(_load(reset: false)),
              child: Text(sm.t('images.loadMore')),
            ),
          IconButton(
            tooltip: sm.t('page.images.title'),
            onPressed: _loading ? null : () => unawaited(_load(reset: true)),
            icon: const Icon(Icons.refresh, size: 20),
          ),
          FilledButton.tonalIcon(
            onPressed: _scanning ? null : () => unawaited(_addFolderAndScan()),
            icon: const Icon(Icons.create_new_folder_outlined, size: 18),
            label: Text(sm.t('images.addFolder')),
          ),
        ],
      ),
    );
  }

  Widget _scanLine(SmStrings sm) {
    final ScanJobInfo? scan = _scan;
    final double value = ((scan?.percent ?? 0) / 100).clamp(0.0, 1.0);
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: SM.contentPad,
        vertical: SM.space100,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          LinearProgressIndicator(value: value, minHeight: 3),
          const SizedBox(height: SM.space100),
          Text(
            sm.t('images.scanning') + ' ' + (scan?.currentPath ?? ''),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: SmText.bodySmall.copyWith(color: context.scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  Widget _errorLine(SmStrings sm) {
    final ColorScheme scheme = context.scheme;
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: SM.contentPad,
        vertical: SM.space100,
      ),
      child: Text(
        _error!,
        style: SmText.bodySmall.copyWith(color: scheme.error),
      ),
    );
  }

  Widget _body(HostController host, SmStrings sm) {
    if (!host.isReady) {
      return Center(
        child: Text(
          sm.t('host.connecting'),
          style: SmText.bodySmall.copyWith(color: context.scheme.onSurfaceVariant),
        ),
      );
    }
    if (_loading && _entries.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_entries.isEmpty) return _empty(sm);
    return GridView.builder(
      padding: const EdgeInsets.all(SM.contentPad),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 220,
        mainAxisSpacing: SM.space300,
        crossAxisSpacing: SM.space300,
      ),
      itemCount: _entries.length,
      itemBuilder: (BuildContext context, int index) {
        final MediaEntry entry = _entries[index];
        return _ThumbTile(entry: entry, thumbPath: _thumbs[entry.id]);
      },
    );
  }

  Widget _empty(SmStrings sm) {
    final ColorScheme scheme = context.scheme;
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(Icons.image_outlined, size: 56, color: scheme.outline),
          const SizedBox(height: SM.space400),
          Text(
            sm.t('images.empty'),
            style: SmText.titleSmall.copyWith(color: scheme.onSurface),
          ),
          const SizedBox(height: SM.space100),
          Text(
            sm.t('images.emptyHint'),
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: SM.space500),
          FilledButton.tonalIcon(
            onPressed: _scanning ? null : () => unawaited(_addFolderAndScan()),
            icon: const Icon(Icons.create_new_folder_outlined, size: 18),
            label: Text(sm.t('images.addFolder')),
          ),
        ],
      ),
    );
  }
}

/// 单张缩略图瓷贴。缩略图是 Rust 生成的磁盘 JPEG，原生页直接 `Image.file` 读，
/// 无需经过 loopback 资源服务（那条路是留给 WebView 播放层的）。
class _ThumbTile extends StatelessWidget {
  const _ThumbTile({required this.entry, required this.thumbPath});

  final MediaEntry entry;
  final String? thumbPath;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final String? path = thumbPath;
    return Tooltip(
      message: entry.displayName,
      waitDuration: const Duration(milliseconds: 600),
      child: ClipRRect(
        borderRadius: SM.rMedium,
        child: ColoredBox(
          color: scheme.surfaceContainerHigh,
          child: path == null
              ? Center(
                  child: Icon(Icons.image_outlined, size: 28, color: scheme.outline),
                )
              : Image.file(
                  File(path),
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                  errorBuilder: (
                    BuildContext context,
                    Object error,
                    StackTrace? stackTrace,
                  ) =>
                      Center(
                    child: Icon(
                      Icons.broken_image_outlined,
                      size: 28,
                      color: scheme.outline,
                    ),
                  ),
                ),
        ),
      ),
    );
  }
}
