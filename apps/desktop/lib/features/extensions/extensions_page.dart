import 'package:flutter/material.dart';

import '../../shell/placeholder_page.dart';

/// /extensions —— P0 阶段的占位页。
///
/// 真实实现在界面框架确认后填入；届时本文件整体替换为实际视图，
/// 路由表与外壳无需改动。
class ExtensionsPage extends StatelessWidget {
  const ExtensionsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const PlaceholderPage(
      routePath: '/extensions',
      icon: Icons.extension_outlined,
      titleKey: 'page.extensions.title',
      descKey: 'page.extensions.desc',
    );
  }
}
