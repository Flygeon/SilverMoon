import 'package:flutter/material.dart';

import '../library/media_grid_page.dart';

/// /images —— 图片库（P0 验收页：列出媒体库文件与缩略图）。
///
/// 视图本身已抽到 [MediaGridPage]；这里只固定类型与页头词条，
/// 保证对外类名与构造（`const ImagesPage({super.key})`）不变，路由表无需改动。
class ImagesPage extends StatelessWidget {
  const ImagesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const MediaGridPage(
      mediaType: 'image',
      titleKey: 'nav.images',
      descKey: 'navDesc.images',
    );
  }
}
