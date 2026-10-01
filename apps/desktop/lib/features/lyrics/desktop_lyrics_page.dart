import 'package:flutter/material.dart';

import '../../shell/placeholder_page.dart';

/// /desktop-lyrics —— P0 阶段的占位页。
///
/// 真实实现在界面框架确认后填入；届时本文件整体替换为实际视图，
/// 路由表与外壳无需改动。
class DesktopLyricsPage extends StatelessWidget {
  const DesktopLyricsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const PlaceholderPage(
      routePath: '/desktop-lyrics',
      icon: Icons.lyrics_outlined,
      titleKey: 'page.desktopLyrics.title',
      descKey: 'page.desktopLyrics.desc',
    );
  }
}
