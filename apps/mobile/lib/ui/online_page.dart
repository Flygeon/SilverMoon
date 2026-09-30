import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:provider/provider.dart';

import '../models/track.dart';
import '../services/player_service.dart';
import '../state/online_controller.dart';
import '../state/settings_controller.dart';
import 'app_shell.dart';
import 'widgets.dart';

/// 在线音乐页：搜索 / 推荐歌单 / 排行榜 / 歌单详情
class OnlinePage extends StatefulWidget {
  const OnlinePage({super.key, this.embedded = false});

  /// 嵌进音乐页签时用 true：不套自己的 Scaffold / AppBar，交给外层。
  /// 桌面端是在同一个 MusicView 里切「本地 / 在线」两个域，移动端照此。
  final bool embedded;

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
      return _frame(
        title: '在线音乐',
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

    return _frame(
      title: '在线音乐',
      actions: <Widget>[
        IconButton(
          tooltip: '刷新',
          icon: const Icon(Icons.refresh_rounded),
          onPressed: () => oc.loadHome(),
        ),
      ],
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

  /// 账号卡：未登录给出扫码入口，已登录显示昵称、连续签到与退出。
  ///
  /// Meting 是聚合源没有账号体系，直接不显示。
  Widget _accountCard(BuildContext context, OnlineController oc) {
    if (!oc.supportsAccount) return const SizedBox.shrink();
    final ColorScheme scheme = Theme.of(context).colorScheme;
    if (!oc.accountLoaded) {
      return const Padding(
        padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: LinearProgressIndicator(minHeight: 2),
      );
    }
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Material(
        color: scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(16),
        clipBehavior: Clip.antiAlias,
        child: oc.loggedIn
            ? Padding(
                padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
                child: Row(
                  children: <Widget>[
                    _avatar(scheme, oc),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            oc.accountName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          Text(
                            oc.server == MusicServer.kugou && oc.signedDays > 0
                                ? '已连续签到 $oc.signedDays 天'
                                : oc.serverLabel,
                            style: TextStyle(
                              fontSize: 12,
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (oc.server == MusicServer.kugou)
                      TextButton(onPressed: oc.signIn, child: const Text('签到')),
                    IconButton(
                      tooltip: '退出登录',
                      icon: const Icon(Icons.logout_rounded, size: 20),
                      onPressed: () => oc.logout(),
                    ),
                  ],
                ),
              )
            : ListTile(
                leading: CircleAvatar(
                  backgroundColor: scheme.primaryContainer,
                  child: Icon(
                    Icons.person_outline_rounded,
                    color: scheme.onPrimaryContainer,
                  ),
                ),
                title: Text('登录${oc.serverLabel}'),
                subtitle: const Text('扫码后可看每日推荐、我的歌单与云盘'),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => showQrLoginSheet(context, oc),
              ),
      ),
    );
  }

  Widget _avatar(ColorScheme scheme, OnlineController oc) {
    final String url = oc.accountAvatar;
    final Widget fallback = CircleAvatar(
      backgroundColor: scheme.primaryContainer,
      child: Icon(Icons.person_rounded, color: scheme.onPrimaryContainer),
    );
    if (url.isEmpty) return fallback;
    return ClipOval(
      child: SizedBox(
        width: 44,
        height: 44,
        child: CachedNetworkImage(
          imageUrl: url,
          fit: BoxFit.cover,
          errorWidget: (_, __, ___) => fallback,
        ),
      ),
    );
  }

  /// 内嵌时只返回内容，独立使用时补上 Scaffold / AppBar。
  Widget _frame({
    required String title,
    List<Widget>? actions,
    required Widget body,
  }) {
    if (widget.embedded) return body;
    return Scaffold(
      appBar: AppBar(title: Text(title), actions: actions),
      body: body,
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
        _accountCard(context, oc),
        if (oc.daily.isNotEmpty) ...<Widget>[
          const SmSectionHeader(title: '每日推荐'),
          for (int i = 0; i < oc.daily.length; i++)
            _onlineTile(oc.daily[i], oc.daily, i, oc),
        ],
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
    final Widget body = oc.loadingPlaylist
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
                );

    if (widget.embedded) {
      // 内嵌时没有 AppBar，用一条紧凑工具行代替返回与批量播放入口
      return Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 4),
            child: Row(
              children: <Widget>[
                IconButton(
                  icon: const Icon(Icons.arrow_back_rounded),
                  onPressed: oc.closePlaylist,
                ),
                Expanded(
                  child: Text(
                    p.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
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
          ),
          Expanded(child: body),
        ],
      );
    }

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
      body: body,
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

/// 扫码登录面板。
///
/// 两个平台的二维码内容形态不同（网易云只有 unikey，要自己拼登录链接），
/// 差异由 OnlineController 抹平，这里只管画和轮询。
Future<void> showQrLoginSheet(BuildContext context, OnlineController oc) async {
  await oc.startQrLogin();
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (BuildContext c) => _QrLoginSheet(online: oc),
  );
}

class _QrLoginSheet extends StatefulWidget {
  const _QrLoginSheet({required this.online});

  final OnlineController online;

  @override
  State<_QrLoginSheet> createState() => _QrLoginSheetState();
}

class _QrLoginSheetState extends State<_QrLoginSheet> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    // 上游要求轮询。两秒一次足够跟上扫码节奏，再快有被限流的风险。
    _timer = Timer.periodic(const Duration(seconds: 2), (Timer t) async {
      final bool done = await widget.online.pollQrLogin();
      if (!mounted) return;
      if (done) {
        t.cancel();
        final NavigatorState nav = Navigator.of(context);
        if (nav.canPop()) nav.pop();
      }
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return AnimatedBuilder(
      animation: widget.online,
      builder: (BuildContext c, Widget? _) {
        final OnlineController oc = widget.online;
        final String? content = oc.qrContent;
        return Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                '扫码登录${oc.serverLabel}',
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 18),
              if (oc.startingQr)
                const SizedBox(
                  height: 216,
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (content == null)
                SizedBox(
                  height: 216,
                  child: Center(
                    child: Text(
                      oc.loginError ?? '二维码获取失败，请稍后重试',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: scheme.error),
                    ),
                  ),
                )
              else
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: QrImageView(
                    data: content,
                    size: 192,
                    backgroundColor: Colors.white,
                  ),
                ),
              const SizedBox(height: 14),
              Text(
                oc.qrStatusText,
                style: TextStyle(color: scheme.onSurfaceVariant),
                textAlign: TextAlign.center,
              ),
            ],
          ),
        );
      },
    );
  }
}
