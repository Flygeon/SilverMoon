import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/track.dart';
import '../services/player_service.dart';
import 'local_pages.dart';
import 'music_page.dart';
import 'now_playing_page.dart';
import 'settings_page.dart';

/// 打开「正在播放」全屏页。
///
/// 音乐页签现在就是原生实现（见 music_page.dart）。这个页面是点击封面、
/// 迷你播放器后进入的「正在播放」全屏页。
void openNowPlaying(BuildContext context) {
  // ignore: unawaited_futures
  Navigator.of(context, rootNavigator: true).push<void>(
    PageRouteBuilder<void>(
      transitionDuration: const Duration(milliseconds: 420),
      reverseTransitionDuration: const Duration(milliseconds: 320),
      pageBuilder: (BuildContext c, Animation<double> a, Animation<double> b) =>
          const NowPlayingPage(),
      transitionsBuilder: (BuildContext c, Animation<double> a,
          Animation<double> b, Widget child) {
        final CurvedAnimation curved = CurvedAnimation(
          parent: a,
          curve: Curves.easeOutCubic,
          reverseCurve: Curves.easeInCubic,
        );
        return SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 1),
            end: Offset.zero,
          ).animate(curved),
          child: FadeTransition(opacity: curved, child: child),
        );
      },
    ),
  );
}

/// 五个页签：图片 / 视频 / 音乐 / 书籍 / 设置。
class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  /// 默认停在「图片」——第一个页签，和桌面端进入应用落在默认视图一致。
  /// （之前为了开发方便停在音乐，等于每次冷启动都强制跳转，很突兀。）
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: const <Widget>[
          ImagesPage(),
          VideosPage(),
          MusicPage(),
          BooksPage(),
          SettingsPage(),
        ],
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 音乐页签自带迷你播放器；切到别的页签时这里补一个原生的，
          // 状态由 Vue 侧的 pinia store 经桥推送过来。
          const NativeMiniPlayer(),
          NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: (int i) => setState(() => _index = i),
            destinations: const <NavigationDestination>[
              NavigationDestination(
                icon: Icon(Icons.photo_library_outlined),
                selectedIcon: Icon(Icons.photo_library_rounded),
                label: '图片',
              ),
              NavigationDestination(
                icon: Icon(Icons.video_library_outlined),
                selectedIcon: Icon(Icons.video_library_rounded),
                label: '视频',
              ),
              NavigationDestination(
                icon: Icon(Icons.library_music_outlined),
                selectedIcon: Icon(Icons.library_music_rounded),
                label: '音乐',
              ),
              NavigationDestination(
                icon: Icon(Icons.menu_book_outlined),
                selectedIcon: Icon(Icons.menu_book_rounded),
                label: '书籍',
              ),
              NavigationDestination(
                icon: Icon(Icons.settings_outlined),
                selectedIcon: Icon(Icons.settings_rounded),
                label: '设置',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 原生迷你播放器：数据直接来自 PlayerService。
///
/// 之前它读的是 BridgeService.player —— WebView 里 Vue store 推过来的状态。
/// 去掉 WebView 之后那个会永远为空，所以整条数据源换掉。
class NativeMiniPlayer extends StatelessWidget {
  const NativeMiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final PlayerService player = context.watch<PlayerService>();
    final Track? t = player.currentTrack;
    if (t == null) return const SizedBox.shrink();
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final Duration? total = player.effectiveDuration;
    final double progress = (total == null || total.inMilliseconds <= 0)
        ? 0
        : (player.position.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0);
    return Material(
      color: scheme.surfaceContainerHigh,
      child: InkWell(
        onTap: () => openNowPlaying(context),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            LinearProgressIndicator(
              value: progress,
              minHeight: 2,
              backgroundColor: Colors.transparent,
            ),
            SizedBox(
              height: 60,
              child: Row(
                children: <Widget>[
                  const SizedBox(width: 10),
                  _miniCover(scheme, t),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          t.displayTitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        Text(
                          t.displayArtist,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    iconSize: 32,
                    icon: Icon(
                      player.playing
                          ? Icons.pause_circle_filled_rounded
                          : Icons.play_circle_fill_rounded,
                    ),
                    onPressed: player.togglePlay,
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_next_rounded),
                    onPressed: player.next,
                  ),
                  const SizedBox(width: 4),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _miniCover(ColorScheme scheme, Track t) {
    final Widget fallback = Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
      ),
      child: const Icon(Icons.music_note_rounded, size: 20),
    );
    final String? url = t.coverUrl;
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
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
}
