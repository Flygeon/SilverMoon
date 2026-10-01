import 'package:flutter/material.dart';

import '../../shell/placeholder_page.dart';

/// /novel-stats —— P0 阶段的占位页。
///
/// 真实实现在界面框架确认后填入；届时本文件整体替换为实际视图，
/// 路由表与外壳无需改动。
class NovelStatsPage extends StatelessWidget {
  const NovelStatsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const PlaceholderPage(
      routePath: '/novel-stats',
      icon: Icons.auto_stories_outlined,
      titleKey: 'page.novelStats.title',
      descKey: 'page.novelStats.desc',
    );
  }
}
