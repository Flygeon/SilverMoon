import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';

import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';

/// Windows 窗口控制按钮（最小化 / 最大化-还原 / 关闭）。
///
/// 尺寸与画法 1:1 对应 Electron 版 `WindowControls.vue`：
/// 44x48 的按钮、10px 量级的线性图标、关闭键 hover 变 #E81123。
class WindowControls extends StatefulWidget {
  const WindowControls({super.key});

  @override
  State<WindowControls> createState() => _WindowControlsState();
}

class _WindowControlsState extends State<WindowControls> with WindowListener {
  bool _maximized = false;

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    unawaited(_syncMaximized());
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  Future<void> _syncMaximized() async {
    final bool maximized = await windowManager.isMaximized();
    if (!mounted) return;
    setState(() => _maximized = maximized);
  }

  @override
  void onWindowMaximize() {
    if (mounted) setState(() => _maximized = true);
  }

  @override
  void onWindowUnmaximize() {
    if (mounted) setState(() => _maximized = false);
  }

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final SmStrings sm = context.watch<AppState>().strings;
    final Color fill = scheme.surfaceContainer;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _ControlButton(
          tooltip: sm.t('titlebar.minimize'),
          onPressed: () => unawaited(windowManager.minimize()),
          glyph: (Color c) => Container(width: 10, height: 1, color: c),
        ),
        _ControlButton(
          tooltip: _maximized ? sm.t('titlebar.restore') : sm.t('titlebar.maximize'),
          onPressed: () => unawaited(_toggleMaximize()),
          glyph: (Color c) => _maximized
              ? SizedBox(
                  width: 10,
                  height: 10,
                  child: Stack(
                    children: <Widget>[
                      Positioned(
                        top: 0,
                        left: 2,
                        child: Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(border: Border.all(color: c, width: 1)),
                        ),
                      ),
                      Positioned(
                        bottom: 0,
                        right: 2,
                        child: Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: fill,
                            border: Border.all(color: c, width: 1),
                          ),
                        ),
                      ),
                    ],
                  ),
                )
              : Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(border: Border.all(color: c, width: 1)),
                ),
        ),
        _ControlButton(
          tooltip: sm.t('titlebar.close'),
          close: true,
          onPressed: () => unawaited(windowManager.close()),
          glyph: (Color c) => SizedBox(
            width: 10,
            height: 10,
            child: Stack(
              alignment: Alignment.center,
              children: <Widget>[
                Transform.rotate(
                  angle: 0.7853981633974483,
                  child: Container(width: 10, height: 1, color: c),
                ),
                Transform.rotate(
                  angle: -0.7853981633974483,
                  child: Container(width: 10, height: 1, color: c),
                ),
              ],
            ),
          ),
        ),
      ],
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

/// 单个窗口控制按钮：自绘 hover / pressed 底色，避免 IconButton 的涟漪。
class _ControlButton extends StatefulWidget {
  const _ControlButton({
    required this.tooltip,
    required this.onPressed,
    required this.glyph,
    this.close = false,
  });

  final String tooltip;
  final VoidCallback onPressed;
  final Widget Function(Color color) glyph;
  final bool close;

  @override
  State<_ControlButton> createState() => _ControlButtonState();
}

class _ControlButtonState extends State<_ControlButton> {
  bool _hover = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final bool dark = context.isDark;

    Color background = Colors.transparent;
    Color foreground = scheme.onSurfaceVariant;

    if (widget.close) {
      if (_pressed) {
        background = const Color(0xFFC50F1F);
        foreground = Colors.white;
      } else if (_hover) {
        background = const Color(0xFFE81123);
        foreground = Colors.white;
      }
    } else {
      if (_pressed) {
        background = dark ? const Color(0x1FFFFFFF) : const Color(0x1A000000);
        foreground = scheme.onSurface;
      } else if (_hover) {
        background = dark ? const Color(0x14FFFFFF) : const Color(0x0F000000);
        foreground = scheme.onSurface;
      }
    }

    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.basic,
        onEnter: (PointerEnterEvent _) => setState(() => _hover = true),
        onExit: (PointerExitEvent _) => setState(() {
          _hover = false;
          _pressed = false;
        }),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (TapDownDetails _) => setState(() => _pressed = true),
          onTapUp: (TapUpDetails _) => setState(() => _pressed = false),
          onTapCancel: () => setState(() => _pressed = false),
          onTap: widget.onPressed,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            curve: Curves.easeOut,
            width: 44,
            height: 48,
            color: background,
            alignment: Alignment.center,
            child: widget.glyph(foreground),
          ),
        ),
      ),
    );
  }
}
