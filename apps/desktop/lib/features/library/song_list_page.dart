import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../bridge/backend_client.dart';
import '../../host/host_controller.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import 'media_entry.dart';

/// 曲目列表的数据源，对应 Rust `commands::song` 的三条命令。
///
/// 三条命令的返回类型都是 `Vec<MediaEntry>`，所以收藏 / 历史 / 回收站共用同一个页面，
/// 差别只在命令名、文案与「是否可清空」。归档侧的 FavoritesView / HistoryView /
/// TrashView 本身也只有 1.5K / 1.5K / 3K，是同一类列表的三种数据源。
enum SongListSource {
  favorites('list_favorites'),
  history('list_history'),
  trash('list_trash');

  const SongListSource(this.command);

  /// 后端命令名。
  final String command;
}

/// 曲目列表页（收藏 / 历史 / 回收站）。
class SongListPage extends StatefulWidget {
  const SongListPage({
    super.key,
    required this.source,
    required this.titleKey,
    required this.descKey,
    this.icon = Icons.music_note_outlined,
    this.canEmpty = false,
  });

  final SongListSource source;
  final String titleKey;
  final String descKey;
  final IconData icon;

  /// 是否显示「清空」（只有回收站为 true，对应 empty_trash 命令）。
  final bool canEmpty;

  @override
  State<SongListPage> createState() => _SongListPageState();
}

class _SongListPageState extends State<SongListPage> {
  List<MediaEntry> _items = <MediaEntry>[];
  bool _loaded = false;
  bool _loading = false;
  String? _error;

  HostController get _host => context.read<HostController>();

  /// 后端握手是异步的，页面可能先于 client 就绪被打开。
  ///
  /// 只在 didChangeDependencies 里判断是不够的：context.read 不建立依赖关系，
  /// client 从 null 变成就绪时不会触发它。改在 build 里 watch 宿主，就绪后
  /// 用微任务补一次加载（直接调用会在 build 期间 setState）。
  void _ensureLoaded(HostController host) {
    if (_loaded || host.client == null) return;
    _loaded = true;
    scheduleMicrotask(() => unawaited(_load()));
  }

  Future<void> _load() async {
    final BackendClient? client = _host.client;
    if (client == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Object? data = (await client.invoke(
        widget.source.command,
        const <String, Object?>{},
      ))
          .unwrap();
      final List<MediaEntry> items = <MediaEntry>[];
      if (data is List) {
        for (final Object? item in data) {
          if (item is Map) items.add(MediaEntry.fromJson(item.cast<String, Object?>()));
        }
      }
      if (!mounted) return;
      setState(() {
        _items = items;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString();
        _loading = false;
      });
    }
  }

  /// 清空回收站是破坏性且不可撤销的，必须先二次确认。
  Future<void> _emptyTrash(SmStrings sm) async {
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(sm.t('actions.empty') + ' ' + sm.t('nav.trash')),
          content: Text(sm.t('navDesc.trash')),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(sm.t('actions.cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(sm.t('actions.confirm')),
            ),
          ],
        );
      },
    );
    if (confirmed != true) return;

    final BackendClient? client = _host.client;
    if (client == null) return;
    try {
      await client.invoke('empty_trash', const <String, Object?>{});
      await _load();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;
    _ensureLoaded(host);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(sm),
        if (_error != null) _errorLine(sm),
        Expanded(child: _body(sm)),
      ],
    );
  }

  Widget _header(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.contentPad, SM.contentPad, 10),
      child: Row(
        children: <Widget>[
          Icon(widget.icon, size: 22, color: scheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  sm.t(widget.titleKey),
                  style: SmText.titleLarge.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: 2),
                Text(
                  _items.isEmpty
                      ? sm.t(widget.descKey)
                      : sm.t(widget.descKey) + ' · ' + _items.length.toString(),
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          if (widget.canEmpty && _items.isNotEmpty)
            TextButton.icon(
              onPressed: () => unawaited(_emptyTrash(sm)),
              icon: const Icon(Icons.delete_sweep_outlined, size: 18),
              label: Text(sm.t('actions.empty')),
            ),
          IconButton(
            tooltip: sm.t('actions.rescan'),
            onPressed: _loading ? null : () => unawaited(_load()),
            icon: _loading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh, size: 20),
          ),
        ],
      ),
    );
  }

  Widget _errorLine(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, 0, SM.contentPad, 8),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: scheme.errorContainer,
          borderRadius: SM.rSmall,
        ),
        child: Text(
          _error!,
          style: SmText.bodySmall.copyWith(color: scheme.onErrorContainer),
        ),
      ),
    );
  }

  Widget _body(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    if (_host.client == null) {
      return Center(
        child: Text(
          sm.t('host.connecting'),
          style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (_items.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(widget.icon, size: 40, color: scheme.outlineVariant),
            const SizedBox(height: 10),
            Text(
              sm.t('library.empty'),
              style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, 0, SM.contentPad, 24),
      itemCount: _items.length,
      separatorBuilder: (BuildContext context, int index) =>
          Divider(height: 1, color: context.hairline),
      itemBuilder: (BuildContext context, int index) =>
          _SongRow(entry: _items[index], showDate: widget.source == SongListSource.trash),
    );
  }
}

/// 单行曲目：标题 + 艺术家/专辑 + 时长/体积。
class _SongRow extends StatelessWidget {
  const _SongRow({required this.entry, required this.showDate});

  final MediaEntry entry;
  final bool showDate;

  /// 优先用扫描到的标题，退化到去掉扩展名的文件名。
  String get _title {
    final String? title = entry.title;
    if (title != null && title.isNotEmpty) return title;
    final int dot = entry.name.lastIndexOf('.');
    return dot > 0 ? entry.name.substring(0, dot) : entry.name;
  }

  String get _subtitle {
    final List<String> parts = <String>[];
    final String? artist = entry.artist;
    final String? album = entry.album;
    if (artist != null && artist.isNotEmpty) parts.add(artist);
    if (album != null && album.isNotEmpty) parts.add(album);
    if (parts.isEmpty) return entry.parent;
    return parts.join(' · ');
  }

  static String _duration(int? ms) {
    if (ms == null || ms <= 0) return '';
    final int totalSeconds = ms ~/ 1000;
    final int minutes = totalSeconds ~/ 60;
    final int seconds = totalSeconds % 60;
    return minutes.toString() + ':' + (seconds < 10 ? '0' : '') + seconds.toString();
  }

  static String _size(int bytes) {
    if (bytes <= 0) return '';
    if (bytes < 1024) return bytes.toString() + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toStringAsFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) {
      return (bytes / (1024 * 1024)).toStringAsFixed(1) + ' MB';
    }
    return (bytes / (1024 * 1024 * 1024)).toStringAsFixed(2) + ' GB';
  }

  static String _date(int ms) {
    if (ms <= 0) return '';
    final DateTime time = DateTime.fromMillisecondsSinceEpoch(ms);
    final String month = time.month < 10 ? '0' + time.month.toString() : time.month.toString();
    final String day = time.day < 10 ? '0' + time.day.toString() : time.day.toString();
    return time.year.toString() + '-' + month + '-' + day;
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final List<String> meta = <String>[
      if (showDate) _date(entry.mtime),
      _duration(entry.durationMs),
      _size(entry.size),
    ].where((String part) => part.isNotEmpty).toList();

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Row(
        children: <Widget>[
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHighest,
              borderRadius: SM.rSmall,
            ),
            child: Icon(Icons.music_note_outlined, size: 18, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  _title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: 2),
                Text(
                  _subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(
            meta.join(' · '),
            style: SmText.bodySmall.copyWith(color: scheme.outline),
          ),
        ],
      ),
    );
  }
}
