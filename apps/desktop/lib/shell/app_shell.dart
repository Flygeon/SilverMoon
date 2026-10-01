import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'host_status_banner.dart';
import 'mini_player_bar.dart';
import 'nav_rail.dart';
import 'window_title_bar.dart';

/// 应用外壳，对应 Electron 版 App.vue 的 `.app-shell` / `.app-body` 结构：
///
///     ┌──────────── 标题栏 48 ────────────┐
///     │ Rail │        内容区（可滚动）     │
///     │ 88px │────────────────────────────│
///     │ 通高 │      迷你播放条 72          │
///     └────────────────────────────────────┘
///
/// 导航 Rail 与内容区**同高**（App.vue 里 .app-body 是 flex 行），
/// 播放条是 `position: fixed; left: var(--lm-nav-width); bottom: 0`，
/// 即只占 Rail 右侧那一列——所以这里把播放条放进右列，而不是横跨整个窗口。
///
/// 播放页 / 桌面歌词页 / 扩展宿主页不走本外壳（路由表里是顶层路由），与 Electron 版一致。
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.location, required this.child});

  /// 当前路由路径，供导航高亮使用（由 ShellRoute 的 state 传入）。
  final String location;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.scheme.surface,
      body: Column(
        children: <Widget>[
          const WindowTitleBar(),
          const HostStatusBanner(),
          Expanded(
            child: Row(
              children: <Widget>[
                NavRail(location: location),
                Expanded(
                  child: Column(
                    children: <Widget>[
                      Expanded(child: child),
                      const MiniPlayerBar(),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
