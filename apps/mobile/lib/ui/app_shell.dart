import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/track.dart';
import '../services/player_service.dart';
import 'library_page.dart';
import 'now_playing_page.dart';
import 'online_page.dart';
import 'settings_page.dart';
import 'widgets.dart';

/// 打开全屏播放器（自下而上 + 淡入）
void openNowPlaying(BuildContext context) {
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

/// 应用外壳：底部导航 + 常驻迷你播放器
class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: const <Widget>[
          LibraryPage(),
          OnlinePage(),
          SettingsPage(),
        ],
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const MiniPlayer(),
          NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: (int i) => setState(() => _index = i),
            destinations: const <Widget>[
              NavigationDestination(
                icon: Icon(Icons.library_music_outlined),
                selectedIcon: Icon(Icons.library_music_rounded),
                label: '音乐',
              ),
              NavigationDestination(
                icon: Icon(Icons.travel_explore_outlined),
                selectedIcon: Icon(Icons.travel_explore_rounded),
                label: '在线',
              ),
              NavigationDestination(
                icon: Icon(Icons.tune_outlined),
                selectedIcon: Icon(Icons.tune_rounded),
                label: '设置',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 迷你播放器（无曲目时自动隐藏）
class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final PlayerService player = context.watch<PlayerService>();
    final Track? track = player.currentTrack;
    if (track == null) return const SizedBox.shrink();

    final ColorScheme scheme = Theme.of(context).colorScheme;
    final ThemeData theme = Theme.of(context);

    return Material(
      color: scheme.surfaceContainerHigh,
      child: InkWell(
        onTap: () => openNowPlaying(context),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            // 顶部细进度线
            LinearProgressIndicator(
              value: player.progress,
              minHeight: 2,
              backgroundColor: scheme.onSurface.withValues(alpha: 0.08),
              valueColor: AlwaysStoppedAnimation<Color>(scheme.primary),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 6, 8),
              child: Row(
                children: <Widget>[
                  CoverArt(track: track, size: 44, radius: 10),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: <Widget>[
                        Text(
                          track.displayTitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          track.displayArtist,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: scheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                  SmCircleButton(
                    icon: player.playing
                        ? Icons.pause_rounded
                        : Icons.play_arrow_rounded,
                    size: 40,
                    iconSize: 24,
                    onTap: () => player.togglePlay(),
                  ),
                  SmCircleButton(
                    icon: Icons.skip_next_rounded,
                    size: 40,
                    iconSize: 22,
                    onTap: player.hasNext ? () => player.next() : null,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
