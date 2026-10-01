import 'package:flutter/material.dart';

import '../library/song_list_page.dart';

/// /history —— 最近播放记录。
///
/// 数据来自 Rust `commands::song::list_history`，
/// 与收藏 / 历史 / 回收站共用同一个列表实现（见 library/song_list_page.dart）。
class HistoryPage extends StatelessWidget {
  const HistoryPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const SongListPage(
      source: SongListSource.history,
      titleKey: 'nav.history',
      descKey: 'navDesc.history',
      icon: Icons.history,

    );
  }
}
