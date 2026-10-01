import 'package:flutter/material.dart';

import '../library/song_list_page.dart';

/// /trash —— 已删除的媒体。
///
/// 数据来自 Rust `commands::song::list_trash`，
/// 与收藏 / 历史 / 回收站共用同一个列表实现（见 library/song_list_page.dart）。
class TrashPage extends StatelessWidget {
  const TrashPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const SongListPage(
      source: SongListSource.trash,
      titleKey: 'nav.trash',
      descKey: 'navDesc.trash',
      icon: Icons.delete_outline,
      canEmpty: true,

    );
  }
}
