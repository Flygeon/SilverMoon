import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../theme/design_tokens.dart';

/// 左侧导航项（对应 App.vue 的 navItems / bottomItems）。
class SmNavDestination {
  const SmNavDestination({
    required this.path,
    required this.icon,
    required this.activeIcon,
    required this.labelKey,
  });

  final String path;
  final IconData icon;
  final IconData activeIcon;
  final String labelKey;
}

/// 主导航：图片 / 视频 / 音乐 / 书籍 / 百宝箱。
///
/// 收藏、历史、回收站、扩展在 Electron 版里已统一收纳进「百宝箱」，
/// 不再单独占底部导航，这里保持一致。
const List<SmNavDestination> kMainDestinations = <SmNavDestination>[
  SmNavDestination(
    path: '/images',
    icon: Icons.image_outlined,
    activeIcon: Icons.image,
    labelKey: 'nav.images',
  ),
  SmNavDestination(
    path: '/videos',
    icon: Icons.movie_outlined,
    activeIcon: Icons.movie,
    labelKey: 'nav.videos',
  ),
  SmNavDestination(
    path: '/music',
    icon: Icons.music_note_outlined,
    activeIcon: Icons.music_note,
    labelKey: 'nav.music',
  ),
  SmNavDestination(
    path: '/books',
    icon: Icons.menu_book_outlined,
    activeIcon: Icons.menu_book,
    labelKey: 'nav.books',
  ),
  SmNavDestination(
    path: '/treasure',
    icon: Icons.inventory_2_outlined,
    activeIcon: Icons.inventory_2,
    labelKey: 'nav.treasure',
  ),
];

/// 底部固定项：设置。
const List<SmNavDestination> kBottomDestinations = <SmNavDestination>[
  SmNavDestination(
    path: '/settings',
    icon: Icons.settings_outlined,
    activeIcon: Icons.settings,
    labelKey: 'nav.settings',
  ),
];

/// 左侧导航 Rail（宽 88，对应 --lm-nav-width）。
class NavRail extends StatelessWidget {
  const NavRail({super.key, required this.location});

  /// 当前路由路径，用于选中态判定（Electron 版同样用严格相等）。
  final String location;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final SmStrings sm = context.watch<AppState>().strings;

    return Container(
      width: SM.navRailWidth,
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border(right: BorderSide(color: context.hairline, width: 1)),
      ),
      padding: const EdgeInsets.fromLTRB(8, 14, 8, 12),
      child: Column(
        children: <Widget>[
          for (final SmNavDestination d in kMainDestinations)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: _NavButton(destination: d, location: location, sm: sm),
            ),
          const Spacer(),
          for (final SmNavDestination d in kBottomDestinations)
            _NavButton(destination: d, location: location, sm: sm),
        ],
      ),
    );
  }
}

/// 单个导航按钮：M3 药丸选中指示器 + 11px 标签。
class _NavButton extends StatefulWidget {
  const _NavButton({required this.destination, required this.location, required this.sm});

  final SmNavDestination destination;
  final String location;
  final SmStrings sm;

  @override
  State<_NavButton> createState() => _NavButtonState();
}

class _NavButtonState extends State<_NavButton> {
  bool _hover = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final bool active = widget.location == widget.destination.path;

    Color pill = Colors.transparent;
    if (active) {
      pill = scheme.secondaryContainer;
    } else if (_hover) {
      pill = scheme.surfaceContainerHigh;
    }
    final Color foreground = active ? scheme.onSecondaryContainer : scheme.onSurfaceVariant;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
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
        onTap: () => context.go(widget.destination.path),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(
            children: <Widget>[
              AnimatedScale(
                scale: _pressed ? 0.9 : 1.0,
                duration: SM.durShort,
                curve: SM.springSpatialFast,
                child: AnimatedContainer(
                  duration: SM.durShort,
                  curve: SM.springEffectsFast,
                  width: SM.navIndicatorWidth,
                  height: SM.navIndicatorHeight,
                  decoration: BoxDecoration(color: pill, borderRadius: BorderRadius.circular(16)),
                  alignment: Alignment.center,
                  child: Icon(
                    active ? widget.destination.activeIcon : widget.destination.icon,
                    size: 22,
                    color: foreground,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(
                widget.sm.t(widget.destination.labelKey),
                style: SmText.labelSmall.copyWith(
                  color: active ? scheme.onSurface : scheme.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
