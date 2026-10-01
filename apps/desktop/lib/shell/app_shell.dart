import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'mini_player_bar.dart';
import 'nav_rail.dart';
import 'window_title_bar.dart';

/// 应用外壳：自上而下是「自定义标题栏 → 左侧导航 + 内容区 → 迷你播放条」。
///
/// 对应 Electron 版 App.vue 的 `.app-shell` 结构。播放页 / 桌面歌词页 /
/// 扩展宿主页不走本外壳（在路由表里是顶层路由），这一点与 Electron 版一致。
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
          Expanded(
            child: Row(
              children: <Widget>[
                NavRail(location: location),
                Expanded(child: child),
              ],
            ),
          ),
          const MiniPlayerBar(),
        ],
      ),
    );
  }
}
