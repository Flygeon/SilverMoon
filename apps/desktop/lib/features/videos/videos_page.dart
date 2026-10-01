import 'package:flutter/material.dart';

import '../library/media_grid_page.dart';

/// /videos —— 视频库（P0 验收页：列出媒体库视频与缩略图）。
///
/// 与图片页共用 [MediaGridPage]：视频缩略图同样由后端 `get_thumbnails` 生成
/// （Rust 侧走 ffmpeg），前端批量补齐的逻辑一字未改。
class VideosPage extends StatelessWidget {
  const VideosPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const MediaGridPage(
      mediaType: 'video',
      titleKey: 'nav.videos',
      descKey: 'navDesc.videos',
      // 网格页默认用图片页文案，这里必须换成视频的，否则会显示「张图片」。
      totalKey: 'videos.total',
      emptyKey: 'videos.empty',
      emptyHintKey: 'videos.emptyHint',
    );
  }
}
