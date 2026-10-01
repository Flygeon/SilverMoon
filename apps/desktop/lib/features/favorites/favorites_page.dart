import 'package:flutter/material.dart';

import '../library/song_list_page.dart';

/// /favorites —— 收藏的媒体。
///
/// 数据来自 Rust `commands::song::list_favorites`，
/// 与收藏 / 历史 / 回收站共用同一个列表实现（见 library/song_list_page.dart）。
class FavoritesPage extends StatelessWidget {
  const FavoritesPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const SongListPage(
      source: SongListSource.favorites,
      titleKey: 'nav.favorites',
      descKey: 'navDesc.favorites',
      icon: Icons.favorite_outline,

    );
  }
}
