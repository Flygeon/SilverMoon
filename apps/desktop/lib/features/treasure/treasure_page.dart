import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';

/// /treasure —— 百宝箱：六个工具的入口卡片。
///
/// 卡片文案全部取自归档词条（settings.treasure.*），与 Electron 版 TreasureView.vue
/// 一致：预设市场 / osu! 谱面 / 听歌统计 / 小说统计 / 文件夹浏览 / WebDAV。
class TreasurePage extends StatelessWidget {
  const TreasurePage({super.key});

  static const List<_TreasureEntry> _entries = <_TreasureEntry>[
    _TreasureEntry(
      route: '/treasure/market',
      icon: Icons.storefront_outlined,
      titleKey: 'settings.treasure.market',
      hintKey: 'settings.treasure.marketHint',
    ),
    _TreasureEntry(
      route: '/treasure/osu',
      icon: Icons.sports_esports_outlined,
      titleKey: 'settings.treasure.osu',
      hintKey: 'settings.treasure.osuHint',
    ),
    _TreasureEntry(
      route: '/stats',
      icon: Icons.insights_outlined,
      titleKey: 'settings.treasure.stats',
      hintKey: 'settings.treasure.statsHint',
    ),
    _TreasureEntry(
      route: '/novel-stats',
      icon: Icons.auto_stories_outlined,
      titleKey: 'settings.treasure.novelStats',
      hintKey: 'settings.treasure.novelStatsHint',
    ),
    _TreasureEntry(
      route: '/folders',
      icon: Icons.folder_open_outlined,
      titleKey: 'settings.treasure.folders',
      hintKey: 'settings.treasure.foldersHint',
    ),
    _TreasureEntry(
      route: '/webdav',
      icon: Icons.cloud_queue_outlined,
      titleKey: 'settings.treasure.webdav',
      hintKey: 'settings.treasure.webdavHint',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final SmStrings sm = context.watch<AppState>().strings;

    return ListView(
      padding: const EdgeInsets.all(SM.contentPad),
      children: <Widget>[
        Text(
          sm.t('settings.treasure.title'),
          style: SmText.titleLarge.copyWith(color: context.scheme.onSurface),
        ),
        const SizedBox(height: 2),
        Text(
          sm.t('settings.treasure.subtitle'),
          style: SmText.bodySmall.copyWith(color: context.scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 16),
        LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            // 卡片按可用宽度分档折行，避免窄窗口挤成单列细条。
            final double width = constraints.maxWidth;
            final int columns = width >= 840 ? 3 : (width >= 560 ? 2 : 1);
            return Wrap(
              spacing: 14,
              runSpacing: 14,
              children: <Widget>[
                for (final _TreasureEntry entry in _entries)
                  SizedBox(
                    width: (constraints.maxWidth - (columns - 1) * 14) / columns,
                    child: _TreasureCard(entry: entry, sm: sm),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }
}

@immutable
class _TreasureEntry {
  const _TreasureEntry({
    required this.route,
    required this.icon,
    required this.titleKey,
    required this.hintKey,
  });

  final String route;
  final IconData icon;
  final String titleKey;
  final String hintKey;
}

class _TreasureCard extends StatelessWidget {
  const _TreasureCard({required this.entry, required this.sm});

  final _TreasureEntry entry;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Material(
      color: scheme.surfaceContainerLow,
      borderRadius: SM.rCard,
      child: InkWell(
        borderRadius: SM.rCard,
        onTap: () => context.go(entry.route),
        child: Container(
          padding: const EdgeInsets.all(18),
          decoration: BoxDecoration(
            borderRadius: SM.rCard,
            border: Border.all(color: context.hairline),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: scheme.primaryContainer,
                  borderRadius: SM.rSmall,
                ),
                child: Icon(entry.icon, size: 20, color: scheme.onPrimaryContainer),
              ),
              const SizedBox(height: 14),
              Text(
                sm.t(entry.titleKey),
                style: SmText.titleMedium.copyWith(color: scheme.onSurface),
              ),
              const SizedBox(height: 4),
              Text(
                sm.t(entry.hintKey),
                style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant, height: 1.55),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
