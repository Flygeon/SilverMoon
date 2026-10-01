import 'dart:async';
import 'dart:io';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../host/host_controller.dart';
import '../../host/json_store.dart';
import '../../host/settings_store.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import 'library_api.dart';
import 'media_entry.dart';

/// 通用媒体网格页 —— 图片页与视频页共用的参数化视图。
///
/// 数据面完全走 Rust。两条取缩略图路径必须区分开，这是大图库不卡的关键：
///   1. **缓存命中**：`list_files` 直接把 `thumbPath` 带回来，命令数为 0；
///   2. **未命中**：只把缺的 id 通过 `get_thumbnails` 一次批量补齐（同下标对应）。
/// 逐张调 `get_thumbnail` 会让 30 张卡片变成 30 次往返，禁止这么写。
///
/// 图片与视频的差别只有三处：`ListQuery.type` 的取值、页头文案、以及缩略图
/// 由后端分别用图像解码 / ffmpeg 生成。交互、分页与扫描流程完全一致，所以抽到
/// 这里；两个 feature 页只负责把类型与词条 key 传进来，不再各写一份。
class MediaGridPage extends StatefulWidget {
  const MediaGridPage({
    super.key,
    required this.mediaType,
    required this.titleKey,
    required this.descKey,
    this.totalKey = 'images.total',
    this.emptyKey = 'images.empty',
    this.emptyHintKey = 'images.emptyHint',
    this.showScanLine = true,
  });

  /// 媒体类型，直接作为 `ListQuery.type` 传给后端：'image' / 'video'。
  final String mediaType;

  /// 页头标题词条 key（对齐 Electron 版 PageHeader 的 title）。
  final String titleKey;

  /// 页头副标题词条 key（对齐 Electron 版 PageHeader 的 description）。
  final String descKey;

  /// 计数后缀词条 key（默认复用图片页文案）。
  final String totalKey;

  /// 空态标题词条 key（默认复用图片页文案）。
  final String emptyKey;

  /// 空态提示词条 key（默认复用图片页文案）。
  final String emptyHintKey;

  /// 是否显示扫描进度行。图片 / 视频页都参与扫描，默认开启；
  /// 将来若有宿主页复用网格但不扫描，可传 false 去掉这行。
  final bool showScanLine;

  @override
  State<MediaGridPage> createState() => _MediaGridPageState();
}

class _MediaGridPageState extends State<MediaGridPage> {
  static const int _pageSize = 200;

  /// 缩略图缺失时的占位图标：视频页不该显示图片图标。
  IconData get _placeholderIcon =>
      widget.mediaType == 'video' ? Icons.movie_outlined : Icons.image_outlined;

  final Map<String, String> _thumbs = <String, String>{};
  List<MediaEntry> _entries = <MediaEntry>[];
  bool _loading = false;
  bool _loaded = false;
  bool _scanning = false;
  String? _error;
  int _total = 0;
  ScanJobInfo? _scan;
  List<String> _savedDirs = <String>[];

  /// 首帧可能早于后端握手完成。这里不用 [HostController.isReady] 而用
  /// [HostController.client]：命令通道可用的充要条件就是 client，且 build 里的
  /// `context.watch` 已建立依赖，client 就绪会触发重建再走到这里补加载。
  void _ensureLoaded(HostController host) {
    if (_loaded || host.client == null) return;
    _loaded = true;
    _savedDirs = _settings?.scanDirs() ?? <String>[];
    // build 期间直接 _load 会触发「build 期间 setState」，排到微任务里执行；
    // 微任务仍可能晚于 dispose，所以保留 mounted 判断。
    scheduleMicrotask(() {
      if (mounted) unawaited(_load(reset: true));
    });
  }

  LibraryApi? get _api => context.read<HostController>().library;

  SettingsStore? get _settings {
    final JsonStore? store = context.read<HostController>().store;
    return store == null ? null : SettingsStore(store);
  }

  Future<void> _load({required bool reset}) async {
    final LibraryApi? api = _api;
    if (api == null || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<MediaEntry> page = await api.listFiles(ListQuery(
        type: widget.mediaType,
        sortBy: 'mtime',
        desc: true,
        limit: _pageSize,
        offset: reset ? 0 : _entries.length,
      ));
      final int total = await api.countFiles(ListQuery(type: widget.mediaType));
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
    final String? dir = await getDirectoryPath(
      confirmButtonText: context.read<AppState>().strings.t('images.addFolder'),
    );
    if (dir == null || !mounted) return;
    // 先记进 settings.json 再扫描：库本身会持久化，但扫描目录不记住的话，
    // 用户下次启动想增量补扫就得重新选一遍目录。
    _settings?.addScanDir(dir);
    _savedDirs = _settings?.scanDirs() ?? _savedDirs;
    await _runScan(<String>[dir]);
  }

  Future<void> _scanSavedDirs() async {
    final List<String> dirs = _savedDirs;
    if (dirs.isEmpty) return;
    await _runScan(dirs);
  }

  /// 发起扫描并轮询进度。
  ///
  /// P0 用 400ms 轮询；后端其实已经在推 scan:progress 事件（宿主的事件总线也已就绪），
  /// P1 把这里换成订阅即可，不必再轮询。
  Future<void> _runScan(List<String> dirs) async {
    final LibraryApi? api = _api;
    if (api == null) return;
    setState(() {
      _scanning = true;
      _error = null;
      _scan = null;
    });
    try {
      final String jobId = await api.scanStart(dirs: dirs);
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
    _ensureLoaded(host);
    final SmStrings sm = context.watch<AppState>().strings;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(sm),
        if (widget.showScanLine && _scanning) _scanLine(sm),
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
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          // 标题 + 副标题对齐 Electron 版 PageHeader；Expanded 让长标题先让位，
          // 右侧的计数与操作按钮始终贴右。
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                Text(
                  sm.t(widget.titleKey),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.titleLarge.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: SM.space50),
                Text(
                  sm.t(widget.descKey),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: SM.space300),
          if (_total > 0)
            Text(
              _total.toString() + ' ' + sm.t(widget.totalKey),
              style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
            ),
          const SizedBox(width: SM.space100),
          if (hasMore && !_loading)
            TextButton(
              onPressed: () => unawaited(_load(reset: false)),
              child: Text(sm.t('images.loadMore')),
            ),
          IconButton(
            tooltip: sm.t('images.refresh'),
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
          Icon(_placeholderIcon, size: 56, color: scheme.outline),
          const SizedBox(height: SM.space400),
          Text(
            sm.t(widget.emptyKey),
            style: SmText.titleSmall.copyWith(color: scheme.onSurface),
          ),
          const SizedBox(height: SM.space100),
          Text(
            sm.t(widget.emptyHintKey),
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: SM.space500),
          FilledButton.tonalIcon(
            onPressed: _scanning ? null : () => unawaited(_addFolderAndScan()),
            icon: const Icon(Icons.create_new_folder_outlined, size: 18),
            label: Text(sm.t('images.addFolder')),
          ),
          if (_savedDirs.isNotEmpty) ...<Widget>[
            const SizedBox(height: SM.space200),
            TextButton(
              onPressed: _scanning ? null : () => unawaited(_scanSavedDirs()),
              child: Text(sm.t('images.scanSaved')),
            ),
          ],
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
                  child: Icon(_placeholderIcon, size: 28, color: scheme.outline),
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
