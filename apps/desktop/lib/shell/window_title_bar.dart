import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:window_manager/window_manager.dart';

import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../theme/design_tokens.dart';
import 'title_bar_menus.dart';
import 'window_controls.dart';

/// Windows 自定义标题栏（对应 Electron 版 `WindowTitleBar.vue`）。
///
/// 无边框窗口由 window_manager 的 `TitleBarStyle.hidden` 负责（见 main.dart），
/// 所以标题栏的全部行为都要自己做：拖拽（startDragging）、双击最大化、
/// 外观菜单、GitHub 链接与窗口控制按钮。
class WindowTitleBar extends StatelessWidget {
  const WindowTitleBar({super.key});

  static const String githubRepo = 'https://github.com/Flygeon/SilverMoon';

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final SmStrings sm = context.watch<AppState>().strings;

    return Container(
      height: SM.titleBarHeight,
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(bottom: BorderSide(color: context.hairline, width: 1)),
      ),
      child: Row(
        children: <Widget>[
          Expanded(child: _DragArea(brandName: sm.t('app.name'))),
          const ThemeMenuButton(),
          const LanguageMenuButton(),
          _TitleBarIconButton(
            tooltip: sm.t('titlebar.github'),
            icon: Icons.code,
            onPressed: () => unawaited(_openRepository()),
          ),
          const WindowControls(),
        ],
      ),
    );
  }

  Future<void> _openRepository() async {
    final Uri uri = Uri.parse(githubRepo);
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // 打不开浏览器不是致命错误：P0 阶段静默即可，后续阶段走系统通知。
    }
  }
}

/// 标题栏左侧的品牌区 + 拖拽区。
class _DragArea extends StatelessWidget {
  const _DragArea({required this.brandName});

  final String brandName;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onPanStart: (DragStartDetails _) => unawaited(windowManager.startDragging()),
      onDoubleTap: () => unawaited(_toggleMaximize()),
      child: Padding(
        padding: const EdgeInsets.only(left: 12),
        child: Row(
          children: <Widget>[
            Icon(Icons.blur_on, size: 20, color: scheme.primary),
            const SizedBox(width: 8),
            Text(
              brandName,
              style: SmText.titleSmall.copyWith(color: scheme.onSurface),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _toggleMaximize() async {
    if (await windowManager.isMaximized()) {
      await windowManager.unmaximize();
    } else {
      await windowManager.maximize();
    }
  }
}

/// 标题栏上的圆形图标按钮（对应 .tb-icon-btn）。
class _TitleBarIconButton extends StatefulWidget {
  const _TitleBarIconButton({required this.tooltip, required this.icon, required this.onPressed});

  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  State<_TitleBarIconButton> createState() => _TitleBarIconButtonState();
}

class _TitleBarIconButtonState extends State<_TitleBarIconButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (PointerEnterEvent _) => setState(() => _hover = true),
        onExit: (PointerExitEvent _) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onPressed,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            curve: Curves.easeOut,
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: _hover ? scheme.surfaceContainerHigh : Colors.transparent,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Icon(
              widget.icon,
              size: 20,
              color: _hover ? scheme.onSurface : scheme.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }
}
