import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../theme/design_tokens.dart';

/// P0 阶段的统一占位页：每个路由都渲染它。
///
/// 页面结构与 Electron 版的 `PageHeader.vue` + `EmptyState.vue` 对齐，
/// 内容换成「这是占位页 + 本页在后续阶段的缺口」，便于逐页比对时一眼看出状态。
class PlaceholderPage extends StatelessWidget {
  const PlaceholderPage({
    super.key,
    required this.routePath,
    required this.icon,
    required this.titleKey,
    required this.descKey,
  });

  /// 路由路径，展示在占位卡片上。
  final String routePath;

  final IconData icon;

  /// 词条 key（见 i18n/sm_strings.dart）。
  final String titleKey;
  final String descKey;

  @override
  Widget build(BuildContext context) {
    final SmStrings sm = context.watch<AppState>().strings;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(SM.contentPad),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          _PageHeader(title: sm.t(titleKey), description: sm.t(descKey)),
          const SizedBox(height: 20),
          _PendingCard(icon: icon, routePath: routePath, sm: sm),
        ],
      ),
    );
  }
}

/// 页头：22px / w500 标题 + 12px 副标题（同 PageHeader.vue）。
class _PageHeader extends StatelessWidget {
  const _PageHeader({required this.title, required this.description});

  final String title;
  final String description;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          title,
          style: SmText.titleLarge.copyWith(color: scheme.onSurface),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 2),
        Text(
          description,
          style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }
}

/// 占位卡片：图标 + 说明 + 路由/阶段 + 已接入/未接入清单。
class _PendingCard extends StatelessWidget {
  const _PendingCard({required this.icon, required this.routePath, required this.sm});

  final IconData icon;
  final String routePath;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return TweenAnimationBuilder<double>(
      tween: Tween<double>(begin: 0, end: 1),
      duration: const Duration(milliseconds: 420),
      curve: SM.springSpatial,
      builder: (BuildContext context, double t, Widget? child) {
        return Opacity(
          opacity: t.clamp(0.0, 1.0).toDouble(),
          child: Transform.translate(offset: Offset(0, 12 * (1 - t)), child: child),
        );
      },
      child: Container(
        width: double.infinity,
        constraints: const BoxConstraints(minHeight: 280),
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 40),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLow,
          borderRadius: SM.rCard,
          border: Border.all(color: context.hairline),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Container(
              width: 56,
              height: 56,
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHigh,
                shape: BoxShape.circle,
              ),
              alignment: Alignment.center,
              child: Icon(icon, size: 28, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            Text(
              sm.t('shell.pendingTitle'),
              style: SmText.titleMedium.copyWith(color: scheme.onSurface),
            ),
            const SizedBox(height: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Text(
                sm.t('shell.pendingDesc'),
                textAlign: TextAlign.center,
                style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant, height: 1.6),
              ),
            ),
            const SizedBox(height: 18),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              alignment: WrapAlignment.center,
              children: <Widget>[
                _Chip(label: sm.t('shell.route'), value: routePath),
                _Chip(label: sm.t('shell.phase'), value: sm.t('shell.phaseValue')),
              ],
            ),
            const SizedBox(height: 22),
            _StatusRow(label: sm.t('shell.wired'), value: sm.t('shell.wiredShell'), ok: true),
            const SizedBox(height: 6),
            _StatusRow(label: sm.t('shell.notWired'), value: sm.t('shell.notWiredList'), ok: false),
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(SM.cornerFull),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Text(
            label + ' · ',
            style: SmText.labelMedium.copyWith(color: scheme.onSurfaceVariant),
          ),
          Text(value, style: SmText.labelMedium.copyWith(color: scheme.onSurface)),
        ],
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.label, required this.value, required this.ok});

  final String label;
  final String value;
  final bool ok;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 560),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(
            ok ? Icons.check_circle_outline : Icons.radio_button_unchecked,
            size: 16,
            color: ok ? scheme.primary : scheme.outline,
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 52,
            child: Text(label, style: SmText.labelMedium.copyWith(color: scheme.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(
              value,
              style: SmText.bodySmall.copyWith(
                color: ok ? scheme.onSurface : scheme.onSurfaceVariant,
                height: 1.6,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
