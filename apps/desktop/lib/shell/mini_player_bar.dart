import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';
import '../theme/design_tokens.dart';

/// 底部迷你播放条，1:1 对应 Electron 版 `components/MiniPlayer.vue`。
///
/// 尺度全部取自原组件（括号里是 theme.css 里的令牌）：
///   总高 72（--lm-miniplayer-height）；顶部 4px 进度轨（surface-container-highest + primary）
///   正文区 68 / 左右内边距 16 / 子元素间距 14
///   封面 48×48（corner-small 8、elevation-1、内描边发丝线）
///   标题 body-medium + w500；副标题与时间 body-small / on-surface-variant（时间用等宽数字）
///   普通图标按钮 30×30、图标 17px；播放键 44 正圆（primary-container 底 + on-primary-container 图标）
///   控件之间 2px；整条点击进入播放页
///
/// 原版 MiniPlayer 是 `position: fixed; left: var(--lm-nav-width); bottom: 0`，
/// 所以导航 Rail 是通高的，播放条只占导航栏右侧那一列——AppShell 按这个结构摆。
///
/// P0 阶段与真实实现的差异（接播放层时抹平）：
///   1. 原版仅在有歌曲时渲染；这里恒常显示，取「无歌曲」形态占位，
///      与 MiniPlayer.vue 的空状态一致：标题 —、副标题「未知艺术家」、时间 0:00 / 0:00。
///   2. 上一首 / 播放 / 下一首 目前是视觉占位（无副作用）；封面区与展开键已可用（跳播放页）。
///   3. 进度轨只呈现进度与 hover 圆点，seek 随播放层接入。
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
      child: Column(
        children: <Widget>[
          const _ProgressTrack(progress: 0),
          Expanded(
            // .body { cursor: pointer }，点击进播放页
            child: MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => context.go('/music/player'),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(
                    children: <Widget>[
                      const _Cover(),
                      const SizedBox(width: 14),
                      Expanded(
                        child: _TrackInfo(
                          // 原版是 `player.song?.title || "—"` / `|| "未知艺术家"`
                          title: '—',
                          artist: sm.t('miniplayer.unknownArtist'),
                        ),
                      ),
                      const SizedBox(width: 14),
                      // 原版是 formatTime(currentTime) + " / " + formatTime(duration)
                      const _TimeLabel(text: '0:00 / 0:00'),
                      const SizedBox(width: 14),
                      _TransportControls(sm: sm),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 顶部进度轨：高 4，底色 surface-container-highest，已播部分 primary；
/// hover 时右端浮出 10px 圆点（原版的 .knob）。
class _ProgressTrack extends StatefulWidget {
  const _ProgressTrack({required this.progress});

  /// 0~1。
  final double progress;

  @override
  State<_ProgressTrack> createState() => _ProgressTrackState();
}

class _ProgressTrackState extends State<_ProgressTrack> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final double ratio = widget.progress.clamp(0.0, 1.0);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: SizedBox(
        height: 4,
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints constraints) {
            final double played = constraints.maxWidth * ratio;
            return Stack(
              clipBehavior: Clip.none,
              children: <Widget>[
                Positioned.fill(child: ColoredBox(color: scheme.surfaceContainerHighest)),
                Positioned(
                  left: 0,
                  top: 0,
                  bottom: 0,
                  right: constraints.maxWidth - played,
                  child: ColoredBox(color: scheme.primary),
                ),
                Positioned(
                  // .knob { right: -5px; width/height 10px }，垂直居中在这 4px 轨道上
                  left: played - 5,
                  top: -3,
                  child: AnimatedOpacity(
                    opacity: _hover ? 1 : 0,
                    duration: SM.durShort,
                    curve: SM.springEffectsFast,
                    child: Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(color: scheme.primary, shape: BoxShape.circle),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// 封面：48×48、圆角 8、surface-container-high 底、elevation-1 + 内描边发丝线。
/// 无封面时用 music_note（原版同款空状态），接入播放层后换成歌曲封面。
class _Cover extends StatelessWidget {
  const _Cover();

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Container(
      width: 48,
      height: 48,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        borderRadius: SM.rSmall,
        border: Border.all(color: context.hairline, width: 1),
        // --md-elevation-1: 0 1px 3px rgba(0, 0, 0, 0.2)
        boxShadow: const <BoxShadow>[
          BoxShadow(color: Color(0x33000000), offset: Offset(0, 1), blurRadius: 3),
        ],
      ),
      child: Icon(Icons.music_note, size: 22, color: scheme.outline),
    );
  }
}

/// 标题 / 艺术家两行，各自单行省略（.info { flex: 1; min-width: 0 }）。
class _TrackInfo extends StatelessWidget {
  const _TrackInfo({required this.title, required this.artist});

  final String title;
  final String artist;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          // .title: font-size body-medium + font-weight 500
          style: SmText.bodyMedium.copyWith(
            fontWeight: FontWeight.w500,
            color: scheme.onSurface,
          ),
        ),
        Text(
          artist,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

/// 时间：body-small / on-surface-variant，等宽数字（.tabular-nums）——秒数跳动时宽度不抖。
class _TimeLabel extends StatelessWidget {
  const _TimeLabel({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      maxLines: 1,
      style: SmText.bodySmall.copyWith(
        color: context.scheme.onSurfaceVariant,
        fontFeatures: const <FontFeature>[FontFeature.tabularFigures()],
      ),
    );
  }
}

/// 控件组：上一首、播放（44 正圆）、下一首、展开，间距 2px（.controls { gap: 2px }）。
///
/// 原版在「网易云已登录 + 在线歌曲」时会在最前面插一个喜欢按钮，本阶段无播放层，不渲染。
class _TransportControls extends StatelessWidget {
  const _TransportControls({required this.sm});

  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        _MiniIconButton(
          icon: Icons.skip_previous,
          tooltip: sm.t('miniplayer.prev'),
          onPressed: _noop,
        ),
        const SizedBox(width: 2),
        _PlayButton(
          playing: false,
          tooltip: sm.t('miniplayer.play'),
          onPressed: _noop,
        ),
        const SizedBox(width: 2),
        _MiniIconButton(
          icon: Icons.skip_next,
          tooltip: sm.t('miniplayer.next'),
          onPressed: _noop,
        ),
        const SizedBox(width: 2),
        _MiniIconButton(
          icon: Icons.expand_less,
          tooltip: sm.t('miniplayer.expand'),
          onPressed: () => context.go('/music/player'),
        ),
      ],
    );
  }
}

/// 播放层未接入前的空操作占位（避免点了没反应却看不出原因——真正实现在 P1）。
void _noop() {}

/// M3 小号标准图标按钮：容器 30×30、图标 17px。
/// 默认 on-surface-variant，hover 出 surface-container-high 圆底并把图标提到 on-surface
/// （theme.css 的 --m3e-standard-icon-button-*）。
class _MiniIconButton extends StatefulWidget {
  const _MiniIconButton({required this.icon, required this.tooltip, this.onPressed});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  State<_MiniIconButton> createState() => _MiniIconButtonState();
}

class _MiniIconButtonState extends State<_MiniIconButton> {
  bool _hover = false;
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => setState(() => _down = true),
          onTapUp: (_) => setState(() => _down = false),
          onTapCancel: () => setState(() => _down = false),
          onTap: widget.onPressed,
          child: AnimatedScale(
            scale: _down ? 0.9 : 1,
            duration: SM.durShort,
            curve: SM.springSpatialFast,
            child: AnimatedContainer(
              duration: SM.durShort,
              curve: SM.springEffectsFast,
              width: 30,
              height: 30,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _hover ? scheme.surfaceContainerHigh : Colors.transparent,
                shape: BoxShape.circle,
              ),
              child: Icon(
                widget.icon,
                size: 17,
                color: _hover ? scheme.onSurface : scheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 播放键：44 正圆、primary-container 底 + on-primary-container 图标；
/// hover 提亮 8%（等价原版的 `filter: brightness(1.08)`）。
class _PlayButton extends StatefulWidget {
  const _PlayButton({required this.playing, required this.tooltip, this.onPressed});

  final bool playing;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  State<_PlayButton> createState() => _PlayButtonState();
}

class _PlayButtonState extends State<_PlayButton> {
  bool _hover = false;
  bool _down = false;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final Color base = scheme.primaryContainer;
    final Color surface = _hover
        ? Color.alphaBlend(Colors.white.withValues(alpha: 0.08), base)
        : base;

    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => setState(() => _down = true),
          onTapUp: (_) => setState(() => _down = false),
          onTapCancel: () => setState(() => _down = false),
          onTap: widget.onPressed,
          child: AnimatedScale(
            scale: _down ? 0.94 : 1,
            duration: SM.durShort,
            curve: SM.springSpatialFast,
            child: AnimatedContainer(
              duration: SM.durShort,
              curve: SM.springEffectsFast,
              width: 44,
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: surface, shape: BoxShape.circle),
              child: Icon(
                widget.playing ? Icons.pause : Icons.play_arrow,
                size: 26,
                color: scheme.onPrimaryContainer,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
