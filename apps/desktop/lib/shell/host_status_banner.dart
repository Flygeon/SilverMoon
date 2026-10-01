import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../host/host_controller.dart';
import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../theme/design_tokens.dart';

/// 后端未就绪时的降级提示条（方案 §2.4：握手失败要「降级 + 提示」，不能白屏）。
///
/// 就绪时整条消失。失败时给出后端原始错误与「重试」，用户不必重启应用。
class HostStatusBanner extends StatelessWidget {
  const HostStatusBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final HostStatus status = host.status;
    if (status == HostStatus.ready || status == HostStatus.idle) {
      return const SizedBox.shrink();
    }

    final bool failed = status == HostStatus.failed;
    final ColorScheme scheme = context.scheme;
    final SmStrings sm = context.watch<AppState>().strings;
    final Color foreground =
        failed ? scheme.onErrorContainer : scheme.onSurfaceVariant;

    return Container(
      width: double.infinity,
      color: failed ? scheme.errorContainer : scheme.surfaceContainerHigh,
      padding: const EdgeInsets.only(
        left: SM.space400,
        right: SM.space200,
        top: SM.space200,
        bottom: SM.space200,
      ),
      child: Row(
        children: <Widget>[
          if (failed)
            Icon(Icons.error_outline, size: 18, color: foreground)
          else
            SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: scheme.onSurfaceVariant,
              ),
            ),
          const SizedBox(width: SM.space200),
          Expanded(
            child: Text(
              failed
                  ? sm.t('host.failed') + '：' + (host.error ?? '')
                  : sm.t('host.connecting'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: SmText.bodySmall.copyWith(color: foreground),
            ),
          ),
          if (failed)
            TextButton(
              onPressed: () => context.read<HostController>().retry(),
              child: Text(sm.t('host.retry')),
            ),
        ],
      ),
    );
  }
}
