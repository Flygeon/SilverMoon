import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/track.dart';
import '../services/player_service.dart';
import '../state/online_controller.dart';
import '../state/settings_controller.dart';
import 'app_shell.dart';
import 'widgets.dart';

/// 在线音乐页：搜索 / 推荐歌单 / 排行榜 / 歌单详情
class OnlinePage extends StatefulWidget {
  const OnlinePage({super.key});

  @override
  State<OnlinePage> createState() => _OnlinePageState();
}

class _OnlinePageState extends State<OnlinePage> {
  final TextEditingController _ctl = TextEditingController();
  bool _homeLoaded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _homeLoaded) return;
      _homeLoaded = true;
      context.read<OnlineController>().loadHome();
    });
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  void _playList(List<Track> list, {int index = 0, bool shuffle = false}) {
    final PlayerService player = context.read<PlayerService>();
    if (list.isEmpty) return;
    if (shuffle) player.setShuffle(true);
    player.setQueue(list, startIndex: index);
    openNowPlaying(context);
  }

  @override
  Widget build(BuildContext context) {
    final OnlineController oc = context.watch<OnlineController>();
    final SettingsController settings = context.watch<SettingsController>();

    if (!settings.settings.enableOnlineMusic) {
      return Scaffold(
        appBar: AppBar(title: const Text('在线音乐')),
        body: SmEmptyState(
          icon: Icons.cloud_off_rounded,
          title: '在线音乐已关闭',
          subtitle: '可在「设置 → 在线音乐」中重新开启',
          actionLabel: '去开启',
          onAction: () => settings.setEnableOnlineMusic(true),
        ),
      );
    }

    if (oc.openedPlaylist != null) {
      return _buildPlaylistDetail(oc);
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('在线音乐'),
        actions: <Widget>[
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh_rounded),
            onPressed: () => oc.loadHome(),
          ),
        ],
      ),
      body: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: SmSegmented<MusicServer>(
              values: const <MusicServer>[
                MusicServer.netease,
                MusicServer.kugou,
                MusicServer.meting,
              ],
              labels: const <String>['网易云', '酷狗', 'Meting'],
              selected: oc.server,
              dense: true,
              onChanged: (MusicServer s) => oc.setServer(s),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: SearchBar(
              controller: _ctl,
              hintText: '搜索歌曲、歌手',
              leading: const Icon(Icons.search_rounded),
              trailing: <Widget>[
                IconButton(
                  icon: const Icon(Icons.close_rounded),
                  onPressed: () {
                    _ctl.clear();
                    oc.search('');
                  },
                ),
              ],
              onSubmitted: (String v) => oc.search(v),
            ),
          ),
          Expanded(
            child: oc.loading
                ? const Center(child: CircularProgressIndicator())
                : oc.results.isNotEmpty
                    ? _buildResults(oc)
                    : _buildHome(oc),
          ),
        ],
      ),
    );
  }

  Widget _buildResults(OnlineController oc) {
    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 20),
      itemCount: oc.results.length + 1,
      itemBuilder: (BuildContext c, int i) {
        if (i == 0) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 16, 8),
            child: Row(
              children: <Widget>[
                Text(
                  '搜索结果 · ' + oc.results.length.toString() + ' 首',
                  style: Theme.of(c).textTheme.bodySmall,
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: () => _playList(oc.results),
                  icon: const Icon(Icons.play_arrow_rounded, size: 18),
                  label: const Text('播放全部'),
                ),
              ],
            ),
          );
        }
        final Track t = oc.results[i - 1];
        return _onlineTile(t, oc.results, i - 1, oc);
      },
    );
  }

  Widget _buildHome(OnlineController oc) {
    if (oc.featured.isEmpty && oc.rankings.isEmpty) {
      return SmEmptyState(
        icon: Icons.travel_explore_rounded,
        title: oc.error ?? '搜索你喜欢的音乐',
        subtitle: '支持网易云 / 酷狗 / Meting 聚合音源',
      );
    }
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: <Widget>[
        if (oc.featured.isNotEmpty) ...<Widget>[
          const SmSectionHeader(title: '推荐歌单'),
          SizedBox(
            height: 190,
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              itemCount: oc.featured.length,
              itemBuilder: (BuildContext c, int i) {
                final OnlinePlaylist p = oc.featured[i];
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: SizedBox(
                    width: 132,
                    child: InkWell(
                      borderRadius: BorderRadius.circular(14),
                      onTap: () => oc.openPlaylist(p),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          CoverArt(
                            track: Track(
                              id: p.id,
                              title: p.name,
                              coverUrl: p.coverUrl,
                            ),
                            size: 132,
                            radius: 14,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            p.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600,
                              height: 1.25,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
        if (oc.rankings.isNotEmpty) ...<Widget>[
          const SmSectionHeader(title: '排行榜'),
          for (final OnlinePlaylist p in oc.rankings)
            ListTile(
              leading: CoverArt(
                track: Track(id: p.id, title: p.name, coverUrl: p.coverUrl),
                size: 52,
                radius: 10,
              ),
              title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(p.creator ?? '官方榜'),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => oc.openPlaylist(p),
            ),
        ],
      ],
    );
  }

  Widget _buildPlaylistDetail(OnlineController oc) {
    final OnlinePlaylist p = oc.openedPlaylist!;
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back_rounded),
          onPressed: oc.closePlaylist,
        ),
        title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: <Widget>[
          IconButton(
            tooltip: '播放全部',
            icon: const Icon(Icons.play_arrow_rounded),
            onPressed: () => _playList(oc.playlistTracks),
          ),
          IconButton(
            tooltip: '随机播放',
            icon: const Icon(Icons.shuffle_rounded),
            onPressed: () => _playList(oc.playlistTracks, shuffle: true),
          ),
        ],
      ),
      body: oc.loadingPlaylist
          ? const Center(child: CircularProgressIndicator())
          : oc.playlistTracks.isEmpty
              ? const SmEmptyState(
                  icon: Icons.music_off_rounded,
                  title: '这个歌单暂时没有可播放的曲目',
                )
              : ListView.builder(
                  padding: const EdgeInsets.only(bottom: 20),
                  itemCount: oc.playlistTracks.length,
                  itemBuilder: (BuildContext c, int i) => _onlineTile(
                    oc.playlistTracks[i],
                    oc.playlistTracks,
                    i,
                    oc,
                  ),
                ),
    );
  }

  Widget _onlineTile(Track t, List<Track> list, int index, OnlineController oc) {
    final PlayerService player = context.watch<PlayerService>();
    final bool current = player.currentTrack?.id == t.id;
    return ListTile(
      leading: CoverArt(track: t, size: 50, radius: 10),
      title: Text(
        t.displayTitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(
          fontWeight: current ? FontWeight.w700 : FontWeight.w500,
          color: current ? Theme.of(context).colorScheme.primary : null,
        ),
      ),
      subtitle: Text(
        t.displayArtist,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (t.duration != null)
            Text(
              t.displayDuration,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
          IconButton(
            icon: const Icon(Icons.more_vert_rounded),
            onPressed: () => _showMenu(t, list, index),
          ),
        ],
      ),
      onTap: () => _playList(list, index: index),
    );
  }

  void _showMenu(Track t, List<Track> list, int index) {
    final PlayerService player = context.read<PlayerService>();
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (BuildContext c) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            ListTile(
              leading: const Icon(Icons.play_arrow_rounded),
              title: const Text('立即播放'),
              onTap: () {
                Navigator.pop(c);
                _playList(list, index: index);
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
      ),
    );
  }
}
