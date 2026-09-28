import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../models/lyric.dart';
import '../theme/design_tokens.dart';

/// 歌词视图（移动端移植版）。
///
/// 还原桌面端算法与观感：
/// - 当前行定位在容器高度 / 2.6 处（SM.playerLyricOffsetDivisor）
/// - 当前行绝对定位，切行时平滑滚动（easeOutCubic）
/// - 逐字卡拉 OK：已唱白色，未唱 0x59FFFFFF（当前行）/ 0x33FFFFFF（非当前行）
/// - 逐字时每个已唱字上移 2px（桌面端 .sung 的 translateY(-2px)）
/// - 间奏三点按 1.5 倍缩放
class LyricsView extends StatefulWidget {
  const LyricsView({
    super.key,
    required this.lyrics,
    required this.position,
    required this.activeIndex,
    required this.fontSize,
    required this.lineHeight,
    required this.lineGap,
    required this.translationSize,
    required this.subMode,
    required this.wordLyrics,
    this.offsetDivisor = SM.lyricOffsetDivisor,
    this.onSeekLine,
  });

  final Lyrics lyrics;

  /// 秒
  final ValueListenable<double> position;
  final int activeIndex;
  final double fontSize;
  final double lineHeight;
  final double lineGap;
  final double translationSize;
  final String subMode;
  final bool wordLyrics;
  final double offsetDivisor;
  final ValueChanged<LyricLine>? onSeekLine;

  @override
  State<LyricsView> createState() => _LyricsViewState();
}

class _LyricsViewState extends State<LyricsView> {
  final ScrollController _ctl = ScrollController();
  int _lastIndex = -1;

  double get _slotHeight => widget.fontSize * widget.lineHeight + widget.lineGap;

  @override
  void didUpdateWidget(covariant LyricsView old) {
    super.didUpdateWidget(old);
    if (old.activeIndex != widget.activeIndex) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToActive());
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToActive(jump: true));
  }

  void _scrollToActive({bool jump = false}) {
    if (!_ctl.hasClients) return;
    final int i = widget.activeIndex;
    if (i < 0 || i == _lastIndex && !jump) return;
    _lastIndex = i;
    final double viewport = _ctl.position.viewportDimension;
    final double target = (i * _slotHeight) - (viewport / widget.offsetDivisor - _slotHeight / 2);
    final double clamped = target.clamp(0.0, _ctl.position.maxScrollExtent);
    if (jump) {
      _ctl.jumpTo(clamped);
    } else {
      _ctl.animateTo(
        clamped,
        duration: const Duration(milliseconds: 360),
        curve: Curves.easeOutCubic,
      );
    }
  }

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final List<LyricLine> lines = widget.lyrics.lines;
    if (lines.isEmpty) {
      return Center(
        child: Text(
          '暂无歌词',
          style: TextStyle(
            color: const Color(0x59FFFFFF),
            fontSize: widget.fontSize * 0.5,
            fontWeight: FontWeight.w500,
          ),
        ),
      );
    }

    return ListView.builder(
      controller: _ctl,
      physics: const ClampingScrollPhysics(),
      padding: EdgeInsets.only(
        top: 0,
        bottom: MediaQuery.of(context).size.height / widget.offsetDivisor,
      ),
      itemExtent: _slotHeight,
      itemCount: lines.length,
      itemBuilder: (BuildContext c, int i) {
        final LyricLine line = lines[i];
        final bool active = i == widget.activeIndex;
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onSeekLine == null ? null : () => widget.onSeekLine!(line),
          child: _LyricLineView(
            line: line,
            active: active,
            sung: i < widget.activeIndex,
            position: widget.position,
            fontSize: widget.fontSize,
            translationSize: widget.translationSize,
            subMode: widget.subMode,
            wordLyrics: widget.wordLyrics,
          ),
        );
      },
    );
  }
}

class _LyricLineView extends StatelessWidget {
  const _LyricLineView({
    required this.line,
    required this.active,
    required this.sung,
    required this.position,
    required this.fontSize,
    required this.translationSize,
    required this.subMode,
    required this.wordLyrics,
  });

  final LyricLine line;
  final bool active;
  final bool sung;
  final ValueListenable<double> position;
  final double fontSize;
  final double translationSize;
  final String subMode;
  final bool wordLyrics;

  static const Color _sungColor = SM.lyricSung;
  static const Color _unsungColor = SM.lyricUnsung;
  static const Color _inactiveColor = SM.lyricInactive;

  @override
  Widget build(BuildContext context) {
    final String sub = subMode == 'none' ? '' : (line.subText(subMode == 'romaji') ?? '');
    final double subSize = fontSize * (translationSize / 100.0) * 0.62;

    if (line.instrumental) {
      return Center(
        child: Transform.scale(
          scale: 1.5,
          child: active
              ? ValueListenableBuilder<double>(
                  valueListenable: position,
                  builder: (BuildContext c, double t, Widget? _) => _buildDots(t),
                )
              : _buildDotsStatic(sung),
        ),
      );
    }

    final Widget textWidget = active
        ? ValueListenableBuilder<double>(
            valueListenable: position,
            builder: (BuildContext c, double t, Widget? _) => _buildActive(t),
          )
        : Text(
            line.text,
            textAlign: TextAlign.center,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: _inactiveColor,
              fontSize: fontSize,
              fontWeight: FontWeight.w500,
              height: 1.2,
            ),
          );

    return AnimatedScale(
      scale: active ? 1.0 : 0.94,
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOutCubic,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            textWidget,
            if (sub.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  sub,
                  textAlign: TextAlign.center,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: active ? const Color(0x8CFFFFFF) : _inactiveColor,
                    fontSize: subSize,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildDots(double t) {
    final double span = line.endTimeEstimate <= 0 ? 1 : line.endTimeEstimate;
    final double p = ((t - line.time) / span).clamp(0.0, 1.0);
    return Text(
      '• • •',
      style: TextStyle(
        fontSize: fontSize * 0.7,
        fontWeight: FontWeight.w700,
        color: Color.lerp(_unsungColor, _sungColor, p),
        letterSpacing: 2,
      ),
    );
  }

  Widget _buildDotsStatic(bool done) => Text(
        '• • •',
        style: TextStyle(
          fontSize: fontSize * 0.7,
          fontWeight: FontWeight.w700,
          color: done ? _sungColor : _inactiveColor,
          letterSpacing: 2,
        ),
      );

  Widget _buildActive(double t) {
    final bool useWords = wordLyrics && line.hasWords;
    if (useWords) {
      return _buildWordLevel(t);
    }
    final double p = _lineProgress(t);
    return _masked(
      line.text,
      p,
      TextStyle(
        fontSize: fontSize,
        fontWeight: FontWeight.w700,
        height: 1.2,
      ),
    );
  }

  /// 行进度（0..1）：有逐字时间轴时按字数加权，否则按行时长线性
  double _lineProgress(double t) {
    final List<WordUnit>? units = line.units;
    if (units != null && units.isNotEmpty) {
      int total = 0;
      for (final WordUnit u in units) {
        total += u.text.length;
      }
      if (total <= 0) return 0;
      double done = 0;
      for (final WordUnit u in units) {
        if (t >= u.end) {
          done += u.text.length;
          continue;
        }
        if (t <= u.start) break;
        final double d = u.end - u.start;
        final double f = d <= 0 ? 1 : (t - u.start) / d;
        done += u.text.length * f.clamp(0.0, 1.0);
        break;
      }
      return (done / total).clamp(0.0, 1.0);
    }
    final double span = line.endTimeEstimate;
    if (span <= 0) return t >= line.time ? 1 : 0;
    return ((t - line.time) / span).clamp(0.0, 1.0);
  }

  Widget _buildWordLevel(double t) {
    final List<WordUnit> units = line.units!;
    final List<Widget> children = <Widget>[];
    for (final WordUnit u in units) {
      double p;
      if (t >= u.end) {
        p = 1;
      } else if (t <= u.start) {
        p = 0;
      } else {
        final double d = u.end - u.start;
        p = d <= 0 ? 1 : ((t - u.start) / d).clamp(0.0, 1.0);
      }
      Widget w = ShaderMask(
        blendMode: BlendMode.srcIn,
        shaderCallback: (Rect b) => LinearGradient(
          colors: const <Color>[_sungColor, _sungColor, _unsungColor, _unsungColor],
          stops: <double>[
            0,
            (p - 0.03).clamp(0.0, 1.0),
            (p + 0.03).clamp(0.0, 1.0),
            1,
          ],
        ).createShader(b),
        child: Text(
          u.text,
          style: const TextStyle(
            color: Colors.white,
            fontWeight: FontWeight.w700,
            height: 1.2,
          ),
        ),
      );
      if (p > 0) {
        // 桌面端 .sung { transform: translateY(-2px) }
        w = Transform.translate(offset: const Offset(0, -2), child: w);
      }
      children.add(w);
    }
    return DefaultTextStyle(
      style: TextStyle(fontSize: fontSize, height: 1.2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        mainAxisSize: MainAxisSize.min,
        children: children,
      ),
    );
  }

  Widget _masked(String text, double p, TextStyle style) {
    return ShaderMask(
      blendMode: BlendMode.srcIn,
      shaderCallback: (Rect b) => LinearGradient(
        colors: const <Color>[_sungColor, _sungColor, _unsungColor, _unsungColor],
        stops: <double>[
          0,
          (p - 0.02).clamp(0.0, 1.0),
          (p + 0.02).clamp(0.0, 1.0),
          1,
        ],
      ).createShader(b),
      child: Text(
        text,
        textAlign: TextAlign.center,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: style.copyWith(color: Colors.white),
      ),
    );
  }
}
