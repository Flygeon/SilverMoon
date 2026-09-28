import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/track.dart';
import '../services/player_service.dart';
import '../state/library_controller.dart';
import '../state/settings_controller.dart';
import 'app_shell.dart';
import 'widgets.dart';

/// 本地音乐页
class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key});

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  bool _searching = false;
  final TextEditingController _searchCtl = TextEditingController();

  @override
  void dispose() {
    _searchCtl.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final LibraryController lib = context.read<LibraryController>();
    final SettingsController s = context.read<SettingsController>();
    List<String> dirs = s.settings.scanDirs;
    if (dirs.isEmpty) {
      dirs = await lib.service.defaultScanDirs();
      await s.setScanDirs(dirs);
    }
    await lib.scan(dirs, minFileSizeMb: s.settings.minFileSizeMb);
    if (!mounted) return;
    final String? msg = lib.message;
    if (msg != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      lib.clearMessage();
    }
  }

  void _playAll(List<Track> list, {int index = 0, bool shuffle = false}) {
    final PlayerService player = context.read<PlayerService>();
    if (list.isEmpty) return;
    if (shuffle) {
      player.setShuffle(true);
    }
    player.setQueue(list, startIndex: index);
    openNowPlaying(context);
  }

  void _showTrackMenu(Track t, List<Track> context_) {
    final PlayerService player = context.read<PlayerService>();
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (BuildContext c) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              ListTile(
                leading: const Icon(Icons.play_arrow_rounded),
                title: const Text('立即播放'),
                onTap: () {
                  Navigator.pop(c);
                  final int i = context_.indexOf(t);
                  _playAll(context_, index: i < 0 ? 0 : i);
                },
              ),
              ListTile(
                leading: const Icon(Icons.queue_play_next_rounded),
                title: const Text('下一首播放'),
                onTap: () {
                  Navigator.pop(c);
                  player.playNext(t);
                },
              ),
              ListTile(
                leading: const Icon(Icons.playlist_add_rounded),
                title: const Text('加入播放队列'),
                onTap: () {
                  Navigator.pop(c);
                  player.addToQueue(t);
                },
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final LibraryController lib = context.watch<LibraryController>();
    final SettingsController settings = context.watch<SettingsController>();
    final PlayerService player = context.watch<PlayerService>();
    final List<Track> list = lib.visible;
    final String view = settings.settings.musicViewMode;

    return Scaffold(
      appBar: AppBar(
        title: _searching
            ? TextField(
                controller: _searchCtl,
                autofocus: true,
                decoration: const InputDecoration(
                  hintText: '搜索本地音乐',
                  border: InputBorder.none,
                ),
                onChanged: lib.setQuery,
              )
            : const Text('音乐'),
        actions: <Widget>[
          IconButton(
            tooltip: _searching ? '关闭搜索' : '搜索',
            icon: Icon(_searching ? Icons.close_rounded : Icons.search_rounded),
            onPressed: () {
              setState(() {
                _searching = !_searching;
                if (!_searching) {
                  _searchCtl.clear();
                  lib.setQuery('');
                }
              });
            },
          ),
          PopupMenuButton<String>(
            tooltip: '排序',
            icon: const Icon(Icons.sort_rounded),
            onSelected: (String v) => lib.setSort(v),
            itemBuilder: (BuildContext c) => const <PopupMenuEntry<String>>[
              PopupMenuItem<String>(value: 'title', child: Text('按标题')),
              PopupMenuItem<String>(value: 'artist', child: Text('按艺术家')),
              PopupMenuItem<String>(value: 'album', child: Text('按专辑')),
              PopupMenuItem<String>(value: 'duration', child: Text('按时长')),
              PopupMenuItem<String>(value: 'added', child: Text('按导入时间')),
            ],
          ),
          IconButton(
            tooltip: '扫描本地音乐',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: lib.scanning ? null : _scan,
          ),
        ],
      ),
      body: lib.scanning
          ? const Center(child: CircularProgressIndicator())
          : list.isEmpty
              ? SmEmptyState(
                  icon: Icons.library_music_outlined,
                  title: lib.tracks.isEmpty ? '还没有本地音乐' : '没有匹配的结果',
                  subtitle: lib.tracks.isEmpty
                      ? '点击下方按钮扫描设备中的音乐文件\nAndroid 会请求媒体读取权限，iOS 请先把音乐放入 App 文稿目录'
                      : null,
                  actionLabel: lib.tracks.isEmpty ? '扫描本地音乐' : null,
                  onAction: lib.tracks.isEmpty ? _scan : null,
                )
              : Column(
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: SmSegmented<String>(
                              values: const <String>['list', 'grid', 'album', 'artist'],
                              labels: const <String>['列表', '网格', '专辑', '歌手'],
                              selected: view,
                              dense: true,
                              onChanged: (String v) => settings.setMusicViewMode(v),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
                      child: Row(
                        children: <Widget>[
                          Expanded(
                            child: Text(
                              list.length.toString() + ' 首 · ' + lib.tracks.length.toString() + ' 首曲库',
                              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                                  ),
                            ),
                          ),
                          FilledButton.tonalIcon(
                            onPressed: () => _playAll(list, shuffle: true),
                            icon: const Icon(Icons.shuffle_rounded, size: 18),
                            label: const Text('随机播放'),
                          ),
                          const SizedBox(width: 8),
                          FilledButton.icon(
                            onPressed: () => _playAll(list),
                            icon: const Icon(Icons.play_arrow_rounded, size: 20),
                            label: const Text('播放'),
                          ),
                        ],
                      ),
                    ),
                    Expanded(child: _buildBody(view, list, player)),
                  ],
                ),
    );
  }

  Widget _buildBody(String view, List<Track> list, PlayerService player) {
    if (view == 'grid') {
      return GridView.builder(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 20),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
          childAspectRatio: 0.78,
          crossAxisSpacing: 12,
          mainAxisSpacing: 12,
        ),
        itemCount: list.length,
        itemBuilder: (BuildContext c, int i) {
          final Track t = list[i];
          return InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: () => _playAll(list, index: i),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Expanded(
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: CoverArt(track: t, radius: 16),
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  t.displayTitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                Text(
                  t.displayArtist,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(c).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          );
        },
      );
    }

    if (view == 'album' || view == 'artist') {
      final List<({String title, String subtitle, List<Track> tracks})> groups =
          <({String title, String subtitle, List<Track> tracks})>[];
      if (view == 'album') {
        for (final e in context.read<LibraryController>().albums) {
          groups.add((title: e.album, subtitle: e.artist, tracks: e.tracks));
        }
      } else {
        for (final e in context.read<LibraryController>().artists) {
          groups.add((
            title: e.artist,
            subtitle: e.tracks.length.toString() + ' 首',
            tracks: e.tracks,
          ));
        }
      }
      return ListView.builder(
        padding: const EdgeInsets.only(bottom: 20),
        itemCount: groups.length,
        itemBuilder: (BuildContext c, int i) {
          final ({String title, String subtitle, List<Track> tracks}) g = groups[i];
          return ListTile(
            leading: CoverArt(track: g.tracks.first, size: 52, radius: 10),
            title: Text(g.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(g.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis),
            trailing: IconButton(
              icon: const Icon(Icons.play_arrow_rounded),
              onPressed: () => _playAll(g.tracks),
            ),
            onTap: () => _playAll(g.tracks),
          );
        },
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 20),
      itemCount: list.length,
      itemBuilder: (BuildContext c, int i) {
        final Track t = list[i];
        final bool current = player.currentTrack?.id == t.id;
        return ListTile(
          leading: CoverArt(track: t, size: 50, radius: 10),
          title: Text(
            t.displayTitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontWeight: current ? FontWeight.w700 : FontWeight.w500,
              color: current ? Theme.of(c).colorScheme.primary : null,
            ),
          ),
          subtitle: Text(
            t.displayArtist + ' · ' + t.displayAlbum,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                t.displayDuration,
                style: Theme.of(c).textTheme.bodySmall?.copyWith(
                      color: Theme.of(c).colorScheme.onSurfaceVariant,
                    ),
              ),
              IconButton(
                icon: const Icon(Icons.more_vert_rounded),
                onPressed: () => _showTrackMenu(t, list),
              ),
            ],
          ),
          onTap: () => _playAll(list, index: i),
        );
      },
    );
  }
}
