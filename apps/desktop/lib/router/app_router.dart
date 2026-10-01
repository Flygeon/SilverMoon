import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../features/books/books_page.dart';
import '../features/extensions/extension_host_page.dart';
import '../features/extensions/extensions_page.dart';
import '../features/favorites/favorites_page.dart';
import '../features/folders/folders_page.dart';
import '../features/history/history_page.dart';
import '../features/images/images_page.dart';
import '../features/lyrics/desktop_lyrics_page.dart';
import '../features/music/music_page.dart';
import '../features/music/music_player_page.dart';
import '../features/settings/settings_page.dart';
import '../features/stats/novel_stats_page.dart';
import '../features/stats/stats_page.dart';
import '../features/trash/trash_page.dart';
import '../features/treasure/osu_page.dart';
import '../features/treasure/preset_market_page.dart';
import '../features/treasure/treasure_page.dart';
import '../features/videos/videos_page.dart';
import '../features/webdav/webdav_page.dart';
import '../shell/app_shell.dart';

/// 桌面端路由表。
///
/// 1:1 对齐 Electron 版 `src/router.ts`：19 条路由 + `/` 重定向到 `/images`。
/// 与 Vue 版一致：播放页、桌面歌词页、扩展宿主页 **不走应用外壳**
/// （Electron 版对这三个路径隐藏标题栏与导航 Rail），所以它们是顶层路由，
/// 而不是 ShellRoute 的子路由。
List<RouteBase> buildAppRoutes() {
  Widget shell(GoRouterState state, Widget child) =>
      AppShell(location: state.uri.path, child: child);

  return <RouteBase>[
    GoRoute(
      path: '/',
      redirect: (BuildContext context, GoRouterState state) => '/images',
    ),
    ShellRoute(
      builder: (BuildContext context, GoRouterState state, Widget child) =>
          shell(state, child),
      routes: <RouteBase>[
        GoRoute(
          path: '/images',
          builder: (BuildContext context, GoRouterState state) => const ImagesPage(),
        ),
        GoRoute(
          path: '/videos',
          builder: (BuildContext context, GoRouterState state) => const VideosPage(),
        ),
        GoRoute(
          path: '/music',
          builder: (BuildContext context, GoRouterState state) => const MusicPage(),
        ),
        GoRoute(
          path: '/books',
          builder: (BuildContext context, GoRouterState state) => const BooksPage(),
        ),
        GoRoute(
          path: '/folders',
          builder: (BuildContext context, GoRouterState state) => const FoldersPage(),
        ),
        GoRoute(
          path: '/webdav',
          builder: (BuildContext context, GoRouterState state) => const WebDavPage(),
        ),
        GoRoute(
          path: '/treasure',
          builder: (BuildContext context, GoRouterState state) => const TreasurePage(),
          routes: <RouteBase>[
            GoRoute(
              path: 'market',
              builder: (BuildContext context, GoRouterState state) => const PresetMarketPage(),
            ),
            GoRoute(
              path: 'osu',
              builder: (BuildContext context, GoRouterState state) => const OsuPage(),
            ),
          ],
        ),
        GoRoute(
          path: '/favorites',
          builder: (BuildContext context, GoRouterState state) => const FavoritesPage(),
        ),
        GoRoute(
          path: '/history',
          builder: (BuildContext context, GoRouterState state) => const HistoryPage(),
        ),
        GoRoute(
          path: '/stats',
          builder: (BuildContext context, GoRouterState state) => const StatsPage(),
        ),
        GoRoute(
          path: '/novel-stats',
          builder: (BuildContext context, GoRouterState state) => const NovelStatsPage(),
        ),
        GoRoute(
          path: '/trash',
          builder: (BuildContext context, GoRouterState state) => const TrashPage(),
        ),
        GoRoute(
          path: '/settings',
          builder: (BuildContext context, GoRouterState state) => const SettingsPage(),
        ),
        GoRoute(
          path: '/extensions',
          builder: (BuildContext context, GoRouterState state) => const ExtensionsPage(),
        ),
      ],
    ),
    // 以下三条不走外壳
    GoRoute(
      path: '/music/player',
      builder: (BuildContext context, GoRouterState state) => const MusicPlayerPage(),
    ),
    GoRoute(
      path: '/desktop-lyrics',
      builder: (BuildContext context, GoRouterState state) => const DesktopLyricsPage(),
    ),
    GoRoute(
      path: '/extension-host',
      builder: (BuildContext context, GoRouterState state) => const ExtensionHostPage(),
    ),
  ];
}

final GoRouter appRouter = GoRouter(
  initialLocation: '/images',
  routes: buildAppRoutes(),
  errorBuilder: (BuildContext context, GoRouterState state) => _RouteErrorPage(
    location: state.uri.toString(),
  ),
);

/// 未知路由的兜底页（Electron 版靠 hash 路由 + redirect 兜底，这里显式给一个页面）。
class _RouteErrorPage extends StatelessWidget {
  const _RouteErrorPage({required this.location});

  final String location;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: scheme.surface,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.error_outline, size: 40, color: scheme.error),
            const SizedBox(height: 12),
            Text('404', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w500, color: scheme.onSurface)),
            const SizedBox(height: 4),
            Text(location, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }
}
