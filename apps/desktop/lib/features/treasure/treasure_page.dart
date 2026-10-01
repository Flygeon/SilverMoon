import 'package:flutter/material.dart';

import '../../shell/placeholder_page.dart';

/// /treasure —— P0 阶段的占位页。
///
/// 真实实现在界面框架确认后填入；届时本文件整体替换为实际视图，
/// 路由表与外壳无需改动。
class TreasurePage extends StatelessWidget {
  const TreasurePage({super.key});

  @override
  Widget build(BuildContext context) {
    return const PlaceholderPage(
      routePath: '/treasure',
      icon: Icons.inventory_2_outlined,
      titleKey: 'page.treasure.title',
      descKey: 'page.treasure.desc',
    );
  }
}
