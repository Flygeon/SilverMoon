import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/track.dart';
import '../services/player_service.dart';
import '../state/library_controller.dart';
import '../state/settings_controller.dart';
import 'app_shell.dart';
import 'online_page.dart';
import 'widgets.dart';

/// 音乐页签（原生实现）。
///
/// 这里原先挂的是 WebView + 复用桌面端的 Vue 前端。那条路在移动端反复出问题
/// （组件没注册、安全区、事件通道、两套设置、两套曲库……），所以改成原生重写。
///
/// 结构对齐桌面端 MusicView：顶部「本地 / 在线」两个域。去掉 WebView 之后
/// LibraryService 成为唯一的本地曲库 —— 设置页的「扫描目录」写的也是它，
/// 不再有两份互不相通的索引。
class MusicPage extends StatefulWidget {
  const MusicPage({super.key});

  @override
  State<MusicPage> createState() => _MusicPageState();
}

class _MusicPageState extends State<MusicPage> {
  /// 0 = 本地，1 = 在线
  int _domain = 0;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _loaded) return;
      _loaded = true;
      context.read<LibraryController>().load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final SettingsController settings = context.watch<SettingsController>();
    final bool onlineOn = settings.settings.enableOnlineMusic;
    return Scaffold(
      appBar: AppBar(
        title: const Text('音乐'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(52),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
            child: SmSegmented<int>(
              values: onlineOn ? const <int>[0, 1] : const <int>[0],
              labels: onlineOn ? const <String>['本地', '在线'] : const <String>['本地'],
              selected: onlineOn ? _domain : 0,
              dense: true,
              onChanged: (int i) => setState(() => _domain = i),
            ),
          ),
        ),
      ),
      body: onlineOn
          ? IndexedStack(
              index: _domain,
              children: <Widget>[
                _buildLocal(context),
                const OnlinePage(embedded: true),
              ],
            )
          : _buildLocal(context),
    );
  }

  Widget _buildLocal(BuildContext context) {
    final LibraryController lib = context.watch<LibraryController>();
    final List<Track> list = lib.visible;
    return Column(
      children: <Widget>[
        if (lib.scanning) const LinearProgressIndicator(minHeight: 2),
        Expanded(
          child: list.isEmpty
              ? _emptyState(context, lib)
              : _buildSongList(context, lib, list),
        ),
      ],
    );
  }

  Widget _emptyState(BuildContext context, LibraryController lib) {
    return SmEmptyState(
      icon: Icons.library_music_rounded,
      title: lib.isEmpty ? '曲库还是空的' : '没有匹配的曲目',
      subtitle: lib.isEmpty
          ? '扫描目录把本地音乐加进来。目录可在「设置 → 本地音乐」里调整。'
          : '换个关键词，或清除搜索条件。',
      actionLabel: lib.isEmpty ? '扫描目录' : null,
      onAction: lib.isEmpty ? () => _scan(context) : null,
    );
  }

  Widget _buildSongList(
    BuildContext context,
    LibraryController lib,
    List<Track> list,
  ) {
    final PlayerService player = context.watch<PlayerService>();
    final Track? cur = player.currentTrack;
    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 12),
      itemCount: list.length + 1,
      itemBuilder: (BuildContext c, int i) {
        if (i == 0) return _buildToolbar(context, lib, list.length);
        final Track t = list[i - 1];
        final bool active = cur != null && cur.id == t.id;
        return ListTile(
          leading: _cover(context, t, active && player.playing),
          title: Text(t.displayTitle, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text(
            t.displayArtist,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: Text(
            t.displayDuration,
            style: TextStyle(
              fontSize: 12,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          selected: active,
          onTap: () {
            player.setQueue(list, startIndex: i - 1);
            openNowPlaying(context);
          },
        );
      },
    );
  }

  Widget _cover(BuildContext context, Track t, bool playing) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final Widget fallback = Container(
      color: scheme.surfaceContainerHighest,
      child: Icon(
        playing ? Icons.graphic_eq_rounded : Icons.music_note_rounded,
        size: 20,
        color: scheme.onSurfaceVariant,
      ),
    );
    final String? url = t.coverUrl;
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(
        width: 44,
        height: 44,
        child: url == null || url.isEmpty
            ? fallback
            : url.startsWith('http')
                ? CachedNetworkImage(
                    imageUrl: url,
                    fit: BoxFit.cover,
                    errorWidget: (_, __, ___) => fallback,
                  )
                : Image.file(
                    File(url),
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => fallback,
                  ),
      ),
    );
  }

  Widget _buildToolbar(BuildContext context, LibraryController lib, int count) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
      child: Row(
        children: <Widget>[
          Expanded(
            child: TextField(
              decoration: const InputDecoration(
                isDense: true,
                hintText: '搜索标题、歌手、专辑',
                prefixIcon: Icon(Icons.search_rounded, size: 20),
                border: OutlineInputBorder(),
              ),
              onChanged: lib.setQuery,
            ),
          ),
          const SizedBox(width: 4),
          IconButton(
            tooltip: '扫描目录',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: () => _scan(context),
          ),
          Text(
            '$count 首',
            style: TextStyle(
              fontSize: 12,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: 8),
        ],
      ),
    );
  }

  Future<void> _scan(BuildContext context) async {
    final LibraryController lib = context.read<LibraryController>();
    final SettingsController s = context.read<SettingsController>();
    List<String> dirs = s.settings.scanDirs;
    if (dirs.isEmpty) {
      dirs = await lib.service.defaultScanDirs();
      await s.setScanDirs(dirs);
    }
    await lib.scan(dirs, minFileSizeMb: s.settings.minFileSizeMb);
    if (!context.mounted) return;
    final String? msg = lib.message;
    lib.clearMessage();
    if (msg != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    }
  }
}
