import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../host/host_controller.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import '../library/library_api.dart';
import '../library/media_entry.dart';
import '../library/media_format.dart';

/// 聚合出的一个已索引目录：路径 + 该目录下的条目数。
@immutable
class _FolderNode {
  const _FolderNode(this.path, this.count);

  final String path;
  final int count;
}

/// /folders —— 按目录浏览已索引的媒体。
///
/// 后端没有「列目录」命令（scan::list_files 的 ListQuery 里没有 parent 字段），
/// 归档 FoldersView.vue 的做法同样是把条目取回来后在客户端按 parent 聚合，
/// 这里沿用同一套语义：左栏是聚合出的目录（带条目数），右栏是该目录下的条目。
class FoldersPage extends StatefulWidget {
  const FoldersPage({super.key});

  @override
  State<FoldersPage> createState() => _FoldersPageState();
}

class _FoldersPageState extends State<FoldersPage> {
  /// 一次取回的上限。目录浏览要的是全貌，分页会让聚合结果残缺。
  static const int _maxEntries = 5000;

  List<MediaEntry> _all = <MediaEntry>[];
  String? _selected;
  String? _error;
  bool _loading = false;
  bool _loaded = false;

  HostController get _host => context.read<HostController>();

  /// 后端握手是异步的：页面可能先于 library 就绪被打开，就绪后补一次加载。
  void _ensureLoaded(HostController host) {
    if (_loaded || host.library == null) return;
    _loaded = true;
    scheduleMicrotask(() {
      if (mounted) unawaited(_load());
    });
  }

  Future<void> _load() async {
    final LibraryApi? api = _host.library;
    if (api == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<MediaEntry> entries = await api.listFiles(
        const ListQuery(limit: _maxEntries),
      );
      if (!mounted) return;
      setState(() {
        _all = entries;
        _loading = false;
        // 选中的目录可能因为重新扫描而消失，此时退回未选中态。
        final String? selected = _selected;
        if (selected != null &&
            !entries.any((MediaEntry entry) => entry.parent == selected)) {
          _selected = null;
        }
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString();
        _loading = false;
      });
    }
  }

  /// 按 parent 聚合出目录列表，路径升序。
  List<_FolderNode> get _folders {
    final Map<String, int> counts = <String, int>{};
    for (final MediaEntry entry in _all) {
      counts[entry.parent] = (counts[entry.parent] ?? 0) + 1;
    }
    final List<_FolderNode> nodes = counts.entries
        .map((MapEntry<String, int> pair) => _FolderNode(pair.key, pair.value))
        .toList();
    nodes.sort((_FolderNode a, _FolderNode b) =>
        a.path.toLowerCase().compareTo(b.path.toLowerCase()));
    return nodes;
  }

  List<MediaEntry> get _items {
    final String? selected = _selected;
    if (selected == null) return <MediaEntry>[];
    final List<MediaEntry> items =
        _all.where((MediaEntry entry) => entry.parent == selected).toList();
    items.sort((MediaEntry a, MediaEntry b) =>
        a.displayName.toLowerCase().compareTo(b.displayName.toLowerCase()));
    return items;
  }

  /// 用系统文件管理器打开该目录（launchUrl 走的是 ShellExecute）。
  Future<void> _reveal(String path) async {
    try {
      await launchUrl(Uri.file(path));
    } catch (_) {
      // 打不开目录不影响浏览本身
    }
  }

  static IconData _iconFor(String type) {
    switch (type) {
      case 'image':
        return Icons.image_outlined;
      case 'video':
        return Icons.movie_outlined;
      case 'audio':
        return Icons.music_note_outlined;
      case 'book':
        return Icons.menu_book_outlined;
      default:
        return Icons.insert_drive_file_outlined;
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
        if (_error != null) _errorLine(),
        Expanded(child: _body(sm, host)),
      ],
    );
  }

  Widget _header(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.contentPad, SM.contentPad, 10),
      child: Row(
        children: <Widget>[
          Icon(Icons.folder_open_outlined, size: 22, color: scheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  sm.t('nav.folders'),
                  style: SmText.titleLarge.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: 2),
                Text(
                  _all.isEmpty
                      ? sm.t('navDesc.folders')
                      : sm.t('navDesc.folders') +
                          ' · ' +
                          _folders.length.toString() +
                          ' ' +
                          sm.t('folders.items'),
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
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

  Widget _errorLine() {
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

  Widget _body(SmStrings sm, HostController host) {
    final ColorScheme scheme = context.scheme;

    if (host.library == null) {
      return Center(
        child: Text(
          sm.t('host.connecting'),
          style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (_all.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.folder_off_outlined, size: 40, color: scheme.outlineVariant),
            const SizedBox(height: 10),
            Text(
              sm.t('folders.empty'),
              style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 4),
            Text(
              sm.t('library.empty'),
              style: SmText.bodySmall.copyWith(color: scheme.outline),
            ),
          ],
        ),
      );
    }

    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SizedBox(width: 300, child: _folderPane(sm)),
        const VerticalDivider(width: 1),
        Expanded(child: _itemPane(sm, scheme)),
      ],
    );
  }

  Widget _folderPane(SmStrings sm) {
    final ColorScheme scheme = context.scheme;
    final List<_FolderNode> folders = _folders;

    return ListView.builder(
      padding: const EdgeInsets.symmetric(vertical: 6),
      itemCount: folders.length,
      itemBuilder: (BuildContext context, int index) {
        final _FolderNode node = folders[index];
        final bool active = node.path == _selected;
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
          child: Material(
            color: active ? scheme.secondaryContainer : Colors.transparent,
            borderRadius: SM.rSmall,
            child: InkWell(
              borderRadius: SM.rSmall,
              onTap: () => setState(() => _selected = node.path),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                child: Row(
                  children: <Widget>[
                    Icon(
                      Icons.folder_outlined,
                      size: 16,
                      color: active
                          ? scheme.onSecondaryContainer
                          : scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        node.path,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: SmText.bodySmall.copyWith(
                          color: active
                              ? scheme.onSecondaryContainer
                              : scheme.onSurface,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      node.count.toString(),
                      style: SmText.labelSmall.copyWith(color: scheme.outline),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _itemPane(SmStrings sm, ColorScheme scheme) {
    final String? selected = _selected;
    if (selected == null) {
      return Center(
        child: Text(
          sm.t('navDesc.folders'),
          style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
        ),
      );
    }
    final List<MediaEntry> items = _items;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  selected,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                items.length.toString() + ' ' + sm.t('folders.items'),
                style: SmText.bodySmall.copyWith(color: scheme.outline),
              ),
              const SizedBox(width: 8),
              TextButton.icon(
                onPressed: () => unawaited(_reveal(selected)),
                icon: const Icon(Icons.open_in_new, size: 16),
                label: Text(sm.t('nav.folders')),
              ),
            ],
          ),
        ),
        Divider(height: 1, color: context.hairline),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
            itemCount: items.length,
            separatorBuilder: (BuildContext context, int index) =>
                Divider(height: 1, color: context.hairline),
            itemBuilder: (BuildContext context, int index) {
              final MediaEntry entry = items[index];
              return Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: <Widget>[
                    Icon(_iconFor(entry.type), size: 18, color: scheme.onSurfaceVariant),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        entry.displayName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Text(
                      formatMediaSize(entry.size),
                      style: SmText.bodySmall.copyWith(color: scheme.outline),
                    ),
                    const SizedBox(width: 6),
                    IconButton(
                      tooltip: sm.t('nav.folders'),
                      icon: const Icon(Icons.folder_open_outlined, size: 16),
                      onPressed: () => unawaited(_reveal(entry.parent)),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }
}
