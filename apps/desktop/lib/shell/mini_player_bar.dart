import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../theme/design_tokens.dart';

/// 底部迷你播放条（对应 Electron 版 `MiniPlayer.vue` 的位置与尺寸）。
///
/// P0 阶段是占位：真实实现要订阅 player:state 事件（方案 §4.4 建议原生 Flutter
/// 重写，而不是为一条 6 KB 的常驻条再挂一个 WebView）。
class MiniPlayerBar extends StatelessWidget {
  const MiniPlayerBar({super.key});

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final SmStrings sm = context.watch<AppState>().strings;

    return Container(
      height: SM.miniPlayerHeight,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        border: Border(top: BorderSide(color: context.hairline, width: 1)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Row(
        children: <Widget>[
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHigh,
              borderRadius: BorderRadius.circular(SM.cornerM),
            ),
            alignment: Alignment.center,
            child: Icon(Icons.music_note_outlined, size: 22, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  sm.t('miniplayer.idle'),
                  style: SmText.titleSmall.copyWith(color: scheme.onSurface),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 2),
                Text(
                  sm.t('miniplayer.hint'),
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          _MiniButton(icon: Icons.skip_previous, tooltip: sm.t('miniplayer.prev')),
          _MiniButton(icon: Icons.play_arrow, tooltip: sm.t('miniplayer.play')),
          _MiniButton(icon: Icons.skip_next, tooltip: sm.t('miniplayer.next')),
        ],
      ),
    );
  }
}

/// 播放条上的传输控制按钮。P0 阶段一律禁用（灰显），避免点出「假响应」。
class _MiniButton extends StatelessWidget {
  const _MiniButton({required this.icon, required this.tooltip});

  final IconData icon;
  final String tooltip;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    return Tooltip(
      message: tooltip,
      child: SizedBox(
        width: 40,
        height: 40,
        child: Icon(icon, size: 22, color: scheme.onSurfaceVariant.withValues(alpha: 0.45)),
      ),
    );
  }
}
