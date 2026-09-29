import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/bridge_service.dart';
import 'local_pages.dart';
import 'music_web_page.dart';
import 'now_playing_page.dart';
import 'settings_page.dart';

/// 打开 Flutter 原生「正在播放」页。
///
/// 音乐页签的主路径是 WebView 里的 Vue 前端（与桌面端同一套代码）；
/// 这个原生实现保留作为兜底入口，Web 资源缺失时仍可播本地曲库。
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
  /// 默认停在音乐（本次开发重点），其余四个是基础本地功能。
  int _index = 2;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: const <Widget>[
          ImagesPage(),
          VideosPage(),
          MusicWebPage(),
          BooksPage(),
          SettingsPage(),
        ],
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // 音乐页签自带迷你播放器；切到别的页签时这里补一个原生的，
          // 状态由 Vue 侧的 pinia store 经桥推送过来。
          if (_index != 2) const NativeMiniPlayer(),
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

/// 原生迷你播放器：只在离开音乐页签时出现，数据来自 WebView 里的播放器状态。
class NativeMiniPlayer extends StatelessWidget {
  const NativeMiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final BridgeService bridge = context.read<BridgeService>();
    return ValueListenableBuilder<PlayerSnapshot>(
      valueListenable: bridge.player,
      builder: (BuildContext context, PlayerSnapshot snap, Widget? _) {
        if (!snap.hasTrack) return const SizedBox.shrink();
        final ColorScheme scheme = Theme.of(context).colorScheme;
        final double progress = snap.durationMs <= 0
            ? 0
            : (snap.positionMs / snap.durationMs).clamp(0.0, 1.0);
        return Material(
          color: scheme.surfaceContainerHigh,
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
                    _cover(scheme, snap),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            snap.title.isEmpty ? '未知曲目' : snap.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          if (snap.artist.isNotEmpty)
                            Text(
                              snap.artist,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 12,
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                    IconButton(
                      iconSize: 32,
                      icon: Icon(
                        snap.playing
                            ? Icons.pause_circle_filled_rounded
                            : Icons.play_circle_fill_rounded,
                      ),
                      onPressed: () => bridge.emit('player:command', 'toggle'),
                    ),
                    IconButton(
                      icon: const Icon(Icons.skip_next_rounded),
                      onPressed: () => bridge.emit('player:command', 'next'),
                    ),
                    const SizedBox(width: 4),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _cover(ColorScheme scheme, PlayerSnapshot snap) {
    final String url = snap.coverUrl;
    if (url.isEmpty) {
      return Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(10),
        ),
        child: const Icon(Icons.music_note_rounded, size: 20),
      );
    }
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Image.network(
        url,
        width: 44,
        height: 44,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => Container(
          width: 44,
          height: 44,
          color: scheme.surfaceContainerHighest,
          child: const Icon(Icons.music_note_rounded, size: 20),
        ),
      ),
    );
  }
}
