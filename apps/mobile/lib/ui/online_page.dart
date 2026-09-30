import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import '../services/bridge_online.dart';
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
                subtitle: const Text('登录后可看每日推荐、我的歌单与云盘'),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => showLoginSheet(context, oc),
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
        if (oc.loggedIn && oc.server == MusicServer.netease) ...<Widget>[
          const SmSectionHeader(title: '云盘'),
          if (oc.loadingCloud)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (oc.cloud.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text('云盘里还没有歌曲', style: TextStyle(fontSize: 12.5)),
            )
          else
            for (int i = 0; i < oc.cloud.length; i++)
              _onlineTile(oc.cloud[i], oc.cloud, i, oc),
          if (oc.myPlaylists.isNotEmpty) ...<Widget>[
            const SmSectionHeader(title: '我的歌单'),
            for (final OnlinePlaylist p in oc.myPlaylists)
              ListTile(
                leading: CoverArt(
                  track: Track(id: p.id, title: p.name, coverUrl: p.coverUrl),
                  size: 52,
                  radius: 10,
                ),
                title: Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text('${p.trackCount ?? 0} 首'),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => oc.openPlaylist(p),
              ),
          ],
        ],
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
    final OnlineController oc = context.read<OnlineController>();
    final bool canComment = t.server == MusicServer.netease;
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
            // 喜欢与评论只有网易云有公开接口（酷狗没有）。
            if (canComment && oc.loggedIn)
              ListTile(
                leading: Icon(
                  oc.isLiked(t)
                      ? Icons.favorite_rounded
                      : Icons.favorite_border_rounded,
                ),
                title: Text(oc.isLiked(t) ? '取消喜欢' : '喜欢'),
                onTap: () {
                  Navigator.pop(c);
                  oc.toggleLike(t);
                },
              ),
            if (canComment)
              ListTile(
                leading: const Icon(Icons.chat_bubble_outline_rounded),
                title: const Text('查看评论'),
                onTap: () {
                  Navigator.pop(c);
                  showCommentsSheet(context, t);
                },
              ),
          ],
        ),
      ),
    );
  }
}

/// 登录面板：扫码 / 手机号验证码两种方式，两个平台共用同一套界面。
///
/// 二维码内容形态由 OnlineController 抹平（网易云只有 unikey，要自己拼链接），
/// 这里只管画、轮询，以及「从官方 App 切回来」时立刻补一次轮询。
Future<void> showLoginSheet(BuildContext context, OnlineController oc) async {
  oc.setPhone('');
  oc.setSmsCode('');
  await oc.startQrLogin();
  if (!context.mounted) return;
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (BuildContext c) => _LoginSheet(online: oc),
  );
}

class _LoginSheet extends StatefulWidget {
  const _LoginSheet({required this.online});

  final OnlineController online;

  @override
  State<_LoginSheet> createState() => _LoginSheetState();
}

class _LoginSheetState extends State<_LoginSheet>
    with WidgetsBindingObserver {
  Timer? _timer;
  /// 0 = 扫码，1 = 手机号。
  int _mode = 0;
  bool _busy = false;
  late final TextEditingController _phoneCtl;
  late final TextEditingController _codeCtl;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _phoneCtl = TextEditingController(text: widget.online.phone);
    _codeCtl = TextEditingController(text: '');
    _startTimer();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _phoneCtl.dispose();
    _codeCtl.dispose();
    super.dispose();
  }

  /// 用户去官方 App 扫码、再切回来时立刻补一次，不等下一个 2s 周期。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed || _mode != 0) return;
    if (_timer == null) _startTimer();
    unawaited(_tick());
  }

  void _startTimer() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 2), (Timer t) {
      unawaited(_tick());
    });
  }

  Future<void> _tick() async {
    if (_busy || _mode != 0) return;
    _busy = true;
    try {
      final bool done = await widget.online.pollQrLogin();
      if (!mounted || !done) return;
      _timer?.cancel();
      _timer = null;
      if (widget.online.loggedIn) {
        final NavigatorState nav = Navigator.of(context);
        if (nav.canPop()) nav.pop();
        return;
      }
      // 过期或授权后拿不到账号：留在面板里显示原因 + 刷新按钮。
      setState(() {});
    } finally {
      _busy = false;
    }
  }

  Future<void> _restartQr() async {
    _timer?.cancel();
    _timer = null;
    await widget.online.startQrLogin();
    if (!mounted) return;
    _startTimer();
  }

  void _setMode(int m) {
    if (_mode == m) return;
    setState(() => _mode = m);
    if (m == 0) {
      // 回到扫码页：二维码还在就继续轮询，过期了或还没取到就重新取。
      if (widget.online.qrContent == null || widget.online.qrExpired) {
        unawaited(_restartQr());
      } else {
        _startTimer();
      }
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return AnimatedBuilder(
      animation: widget.online,
      builder: (BuildContext c, Widget? _) {
        final OnlineController oc = widget.online;
        return Padding(
          padding: EdgeInsets.fromLTRB(
            24,
            0,
            24,
            24 + MediaQuery.viewInsetsOf(context).bottom,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text(
                '登录${oc.serverLabel}',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 14),
              Center(
                child: SegmentedButton<int>(
                  segments: const <ButtonSegment<int>>[
                    ButtonSegment<int>(value: 0, label: Text('扫码登录')),
                    ButtonSegment<int>(value: 1, label: Text('手机号登录')),
                  ],
                  selected: <int>{_mode},
                  showSelectedIcon: false,
                  onSelectionChanged: (Set<int> s) => _setMode(s.first),
                ),
              ),
              const SizedBox(height: 16),
              if (_mode == 0) ..._qrSection(oc, scheme) else ..._phoneSection(oc, scheme),
            ],
          ),
        );
      },
    );
  }

  List<Widget> _qrSection(OnlineController oc, ColorScheme scheme) {
    final String? content = oc.qrContent;
    return <Widget>[
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
        Center(
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Opacity(
              opacity: oc.qrExpired ? 0.25 : 1,
              child: QrImageView(
                data: content,
                size: 192,
                backgroundColor: Colors.white,
              ),
            ),
          ),
        ),
      const SizedBox(height: 14),
      Text(
        oc.qrStatusText,
        style: TextStyle(color: scheme.onSurfaceVariant),
        textAlign: TextAlign.center,
      ),
      if (oc.loginError != null && content != null) ...<Widget>[
        const SizedBox(height: 8),
        Text(
          oc.loginError!,
          textAlign: TextAlign.center,
          style: TextStyle(color: scheme.error, fontSize: 12.5),
        ),
      ],
      if (oc.qrExpired || oc.loginError != null) ...<Widget>[
        const SizedBox(height: 10),
        Center(
          child: TextButton.icon(
            onPressed: () => unawaited(_restartQr()),
            icon: const Icon(Icons.refresh_rounded),
            label: const Text('刷新二维码'),
          ),
        ),
      ],
    ];
  }

  List<Widget> _phoneSection(OnlineController oc, ColorScheme scheme) {
    return <Widget>[
      TextField(
        controller: _phoneCtl,
        keyboardType: TextInputType.phone,
        maxLength: 11,
        onChanged: oc.setPhone,
        decoration: const InputDecoration(
          labelText: '手机号',
          hintText: '请输入 11 位手机号',
          counterText: '',
          border: OutlineInputBorder(),
        ),
      ),
      const SizedBox(height: 12),
      Row(
        children: <Widget>[
          Expanded(
            child: TextField(
              controller: _codeCtl,
              keyboardType: TextInputType.number,
              maxLength: 6,
              onChanged: oc.setSmsCode,
              decoration: const InputDecoration(
                labelText: '验证码',
                counterText: '',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            height: 48,
            child: TextButton(
              onPressed: (oc.sendingSms || oc.smsCooldown > 0)
                  ? null
                  : () => unawaited(oc.sendSmsCode()),
              child: Text(
                oc.smsCooldown > 0
                    ? '${oc.smsCooldown}s'
                    : (oc.sendingSms ? '发送中…' : '获取验证码'),
              ),
            ),
          ),
        ],
      ),
      if (oc.phoneError != null) ...<Widget>[
        const SizedBox(height: 8),
        Text(
          oc.phoneError!,
          style: TextStyle(color: scheme.error, fontSize: 12.5),
        ),
      ],
      const SizedBox(height: 16),
      FilledButton(
        onPressed: oc.phoneLoggingIn
            ? null
            : () async {
                final bool ok = await oc.loginWithPhone();
                if (!ok || !mounted) return;
                final NavigatorState nav = Navigator.of(context);
                if (nav.canPop()) nav.pop();
              },
        child: Text(oc.phoneLoggingIn ? '登录中…' : '登录'),
      ),
      const SizedBox(height: 6),
      Text(
        oc.server == MusicServer.netease
            ? '需先在网易云音乐 App 绑定手机号；登录即表示同意其服务条款。'
            : '验证码由酷狗音乐下发，若未收到请稍后再试。',
        textAlign: TextAlign.center,
        style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
      ),
    ];
  }
}

/// 歌曲评论面板。只对网易云有效，酷狗没有公开的评论接口。
Future<void> showCommentsSheet(BuildContext context, Track t) async {
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (BuildContext c) => FractionallySizedBox(
      heightFactor: 0.85,
      child: _CommentsSheet(track: t),
    ),
  );
}

class _CommentsSheet extends StatefulWidget {
  const _CommentsSheet({required this.track});

  final Track track;

  @override
  State<_CommentsSheet> createState() => _CommentsSheetState();
}

class _CommentsSheetState extends State<_CommentsSheet> {
  List<Map<String, dynamic>> _hot = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> _all = <Map<String, dynamic>>[];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final OnlineMusicService svc = context.read<OnlineMusicService>();
    try {
      final Object? r = await svc.neteaseSongComments(<String, dynamic>{
        'id': int.tryParse(widget.track.sourceKey ?? '') ?? 0,
        'limit': 30,
      });
      if (!mounted) return;
      final Map<String, Object?> m =
          r is Map ? Map<String, Object?>.from(r) : <String, Object?>{};
      setState(() {
        _hot = _castList(m['hotComments']);
        _all = _castList(m['comments']);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  static List<Map<String, dynamic>> _castList(Object? v) => v is List
      ? v
          .whereType<Map<dynamic, dynamic>>()
          .map((Map<dynamic, dynamic> e) => Map<String, dynamic>.from(e))
          .toList()
      : <Map<String, dynamic>>[];

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
          child: Text(
            widget.track.displayTitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
          ),
        ),
        if (_loading)
          const Expanded(child: Center(child: CircularProgressIndicator()))
        else if (_error != null)
          Expanded(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(_error!, textAlign: TextAlign.center),
              ),
            ),
          )
        else if (_hot.isEmpty && _all.isEmpty)
          const Expanded(
            child: Center(child: Text('这首歌还没有评论')),
          )
        else
          Expanded(
            child: ListView(
              padding: const EdgeInsets.only(bottom: 24),
              children: <Widget>[
                if (_hot.isNotEmpty) ...<Widget>[
                  const SmSectionHeader(title: '精彩评论'),
                  for (final Map<String, dynamic> c in _hot) _tile(scheme, c),
                ],
                if (_all.isNotEmpty) ...<Widget>[
                  const SmSectionHeader(title: '最新评论'),
                  for (final Map<String, dynamic> c in _all) _tile(scheme, c),
                ],
              ],
            ),
          ),
      ],
    );
  }

  Widget _tile(ColorScheme scheme, Map<String, dynamic> c) {
    final Object? u = c['user'];
    final Map<String, dynamic> user =
        u is Map ? Map<String, dynamic>.from(u) : <String, dynamic>{};
    final String avatar = (user['avatarUrl'] ?? '').toString();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          ClipOval(
            child: SizedBox(
              width: 34,
              height: 34,
              child: avatar.isEmpty
                  ? Container(color: scheme.surfaceContainerHighest)
                  : CachedNetworkImage(imageUrl: avatar, fit: BoxFit.cover),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  (user['nickname'] ?? '匿名用户').toString(),
                  style: TextStyle(fontSize: 12.5, color: scheme.primary),
                ),
                const SizedBox(height: 2),
                Text((c['content'] ?? '').toString()),
                const SizedBox(height: 4),
                Row(
                  children: <Widget>[
                    Icon(
                      Icons.thumb_up_alt_outlined,
                      size: 13,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      (c['likedCount'] ?? 0).toString(),
                      style: TextStyle(
                        fontSize: 11.5,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
