import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../models/lyric.dart';
import '../theme/design_tokens.dart';

/// 桌面端 src/components/LyricsView.vue 的动效常量，数值一一对应，勿改。
///
/// 桌面端注释（勿改为容器滚动）：
///   每行绝对定位，靠各自的 translateY 位移，而不是滚动容器。
///   容器 scrollTo 只能整体平移，做不出参考里「每行独立缓动 + 逐行错开」
///   的 Apple Music 波浪感。
class _LyricMotion {
  _LyricMotion._();

  /// transition: all 0.7s cubic-bezier(0.19, 0.11, 0, 1)。
  static const Duration slideDuration = Duration(milliseconds: 700);

  /// .lyric-text.pop { animation: lyric-pop 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) }。
  static const Duration popDuration = Duration(milliseconds: 500);

  /// 逐字上浮：.word { transition: transform 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) }。
  static const Duration wordLiftDuration = Duration(milliseconds: 500);

  /// 手势回中动画（桌面端没有，移动端补的）。
  static const Duration returnDuration = Duration(milliseconds: 520);

  /// 松手后自动回到当前行的等待时间。策划书 04-lyrics.md §4.5：autoReturnMs = 3000。
  static const Duration returnDelay = Duration(seconds: 3);

  /// 级联启动步长：桌面端 delay = (n * 70 - n * 10) * animate。
  static const int staggerStepMs = 60;

  /// if (n > 10) n = 0; —— 距离超过 10 行直接同步归位，避免长尾卡顿。
  static const int staggerLimit = 10;

  /// .lyric-item { padding: 0 25px }。
  static const double horizontalPadding = 25;

  /// 惯性：策划书 §4.5 —— inertiaDistance = (velocity * 0.3).clamp(-300, 300)。
  static const double inertiaFactor = 0.3;
  static const double inertiaLimit = 300;

  /// 模糊的距离上限（**移动端取舍，非桌面端行为**）。
  ///
  /// 桌面端 filter: blur(distance px) 不封顶，会把近百行全部丢进 GPU 滤镜。
  /// 容器遮罩只让 22%~74% 这一段可见，按 30px 字号 / 2.5 行高 / 20px 行距算，
  /// 任意时刻落在可见带里的行不超过约 5 行，更远的行早已被遮罩吃掉。
  /// 因此这里只给 [blurDistanceLimit] 以内的近邻行做模糊，其余直接跳过，
  /// 换来的是省掉数十层的 saveLayer + 高斯卷积。
  static const int blurDistanceLimit = 6;

  /// 需要做透明度过渡的行距上限（fadeFor 在 distance>=4 就饱和到 0.22 了）。
  static const int animatedFadeDistance = 6;

  /// 非当前行透明度：Math.max(0.22, 1 - distance * 0.22)。
  static double fadeFor(int distance) {
    final double v = 1 - distance * 0.22;
    return v < 0.22 ? 0.22 : v;
  }

  /// 逐字填充软边：桌面端 47%→53%（渐变盒 2 倍宽）约合 0.06 个词宽。
  static const double wordSoftEdge = 0.06;
}

/// 歌词视图（移动端移植版）——逐条还原桌面端 LyricsView.vue 的动效。
///
/// - 每行 Positioned 绝对定位，各自动画 translateY；切行时按
///   n * 60ms 错开启动，形成 Apple Music 的波浪推进。
/// - 当前行停靠在容器高度 / offsetDivisor（默认 2.6）。
/// - 非当前行按距离 max(0.22, 1 - d * 0.22) 衰减，近邻行再叠加 blur(d)。
/// - 行高按内容用 TextPainter 精确测量后累加，双语 / 换行都能对齐。
/// - 逐字卡拉 OK：已唱纯白、未唱半透明；唱完的字上浮 2px 并保持。
/// - 当前行入场 scale 0.97 -> 1（cubic-bezier(0.34, 1.2, 0.64, 1)）。
/// - 上下渐隐遮罩：桌面端 mask-image: linear-gradient(...)。
///
/// 与桌面端的**刻意差异**（移动端适配，其余一律以 .vue 为准）：
/// - 补了拖动 + 3s 自动回中（桌面端歌词不接收拖动手势）。
/// - 遮罩 / 裁剪固定在容器上，只有内容参与位移；拖动时渐隐带不跟着跑。
/// - 模糊只给可见带内的近邻行（见 [_LyricMotion.blurDistanceLimit]）。
/// - 歌词整行居中（桌面端左对齐）；pop 的 transform-origin 随之用 center。
/// - 不加 text-shadow：桌面端阴影在 ShaderMask 逐字填充下会被一起染色。
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
    required this.translationGap,
    required this.subMode,
    required this.wordLyrics,
    this.blur = true,
    this.offsetDivisor = SM.lyricOffsetDivisor,
    this.onSeekLine,
  });

  final Lyrics lyrics;

  /// 播放位置（秒）。
  final ValueListenable<double> position;
  final int activeIndex;
  final double fontSize;

  /// 行高倍数（桌面端 settings.lyricLineHeight，缺省 2.5）。
  final double lineHeight;
  final double lineGap;

  /// 副行字号百分比（桌面端 lyricTranslationSize + '%'，缺省 62）。
  final double translationSize;
  final double translationGap;
  final String subMode;
  final bool wordLyrics;
  final bool blur;
  final double offsetDivisor;
  final ValueChanged<LyricLine>? onSeekLine;

  @override
  State<LyricsView> createState() => _LyricsViewState();
}

class _LyricsViewState extends State<LyricsView>
    with SingleTickerProviderStateMixin {
  /// 用户拖动造成的整体位移（桌面端没有，回中后归 0）。
  final ValueNotifier<double> _dragY = ValueNotifier<double>(0);
  late final AnimationController _returnCtl;
  double _returnFrom = 0;
  double _returnTo = 0;
  Timer? _returnTimer;
  bool _dragging = false;

  /// 布局基准行（拖动期间冻结，避免内容在手指下被自动跟随拽走）。
  int _layoutIndex = 0;

  /// true = 本次位移变化带级联动效；false = 立即就位（换歌 / 改字号 / 改窗口）。
  bool _animateLayout = true;

  /// 第 i 行按「整段 Text」渲染时的高度（非当前行、或关闭逐字歌词时）。
  List<double> _plainHeights = const <double>[];

  /// 第 i 行按「逐词 Wrap」渲染时的高度（仅当前行、且开启逐字歌词时）。
  ///
  /// 两种渲染方式的行数可能不同（桌面端每次 updateLayout 都重读 offsetHeight
  /// 自愈；移动端缓存了测量结果，必须为两种形态各存一份，否则切行瞬间行距抖动）。
  List<double> _wrapHeights = const <double>[];
  double _rowHeight = 0;

  // ---- 测量缓存键 ----
  double _measureWidth = -1;
  double _measureTextScale = -1;
  Lyrics? _measureLyrics;
  double _measureFontSize = -1;
  double _measureLineHeight = -1;
  double _measureTranslationSize = -1;
  double _measureTranslationGap = -1;
  String _measureSubMode = '';
  bool _measureWordLyrics = true;

  /// 容器高度（变化时也要立即就位，对应桌面端 ResizeObserver 的 animate=0）。
  double _measureHeight = -1;

  @override
  void initState() {
    super.initState();
    _layoutIndex = _clampIndex(widget.activeIndex, widget.lyrics.lines.length);
    _returnCtl = AnimationController(
      vsync: this,
      duration: _LyricMotion.returnDuration,
    );
    _returnCtl.addListener(() {
      _dragY.value = _returnFrom +
          (_returnTo - _returnFrom) * SM.amEaseLyric.transform(_returnCtl.value);
    });
  }

  @override
  void didUpdateWidget(covariant LyricsView old) {
    super.didUpdateWidget(old);
    // 换歌：直接落到新歌当前行，不走过渡（桌面端 resetLayout + no-transition）。
    if (!identical(old.lyrics, widget.lyrics)) {
      _returnTimer?.cancel();
      _returnCtl.stop();
      _dragY.value = 0;
      _layoutIndex = _clampIndex(widget.activeIndex, widget.lyrics.lines.length);
      _animateLayout = false;
      return;
    }
    final int target = _clampIndex(widget.activeIndex, widget.lyrics.lines.length);
    // 用户拖走时冻结布局基准，回中时再追上（移动端补充）。
    if (target != _layoutIndex && !_dragging && _dragY.value.abs() < 0.5) {
      _animateLayout = true;
      _layoutIndex = target;
    }
  }

  @override
  void dispose() {
    _returnTimer?.cancel();
    _returnCtl.dispose();
    _dragY.dispose();
    super.dispose();
  }

  /// 换歌那一帧可能歌词已换、activeIndex 还是旧值，越界会让所有行偏移错乱。
  static int _clampIndex(int index, int length) {
    if (length <= 0) {
      return 0;
    }
    if (index < 0) {
      return 0;
    }
    return index > length - 1 ? length - 1 : index;
  }

  // ------------------------------------------------------------ 手势 / 回中

  void _cancelReturn() {
    _returnTimer?.cancel();
    _returnCtl.stop();
  }

  void _onDragStart(DragStartDetails details) {
    _dragging = true;
    _cancelReturn();
  }

  void _onDragUpdate(DragUpdateDetails details) {
    _dragging = true;
    _cancelReturn();
    _dragY.value += details.delta.dy;
  }

  void _onDragEnd(DragEndDetails details) {
    _dragging = false;
    final double velocity = details.primaryVelocity ?? 0;
    // 惯性滑行：把松手速度折成一小段位移，再等 3s 回中。
    final double glide = (velocity * _LyricMotion.inertiaFactor)
        .clamp(-_LyricMotion.inertiaLimit, _LyricMotion.inertiaLimit);
    if (glide.abs() >= 1) {
      _glideThenReturn(_dragY.value + glide);
    } else {
      _scheduleReturn();
    }
  }

  /// 识别器被淘汰 / 指针被取消时只会回调这个；不接会让 _dragging 永久为真，
  /// 之后歌词再也不会跟随 activeIndex，且永远不会自动回中。
  void _onDragCancel() {
    _dragging = false;
    _scheduleReturn();
  }

  void _glideThenReturn(double target) {
    _returnTimer?.cancel();
    _returnFrom = _dragY.value;
    _returnTo = target;
    unawaited(_returnCtl.forward(from: 0).whenComplete(() {
      if (!mounted) {
        return;
      }
      _dragY.value = _returnTo;
      _scheduleReturn();
    }));
  }

  void _scheduleReturn() {
    _returnTimer?.cancel();
    _returnTimer = Timer(_LyricMotion.returnDelay, () {
      if (!mounted) {
        return;
      }
      _syncLayoutIndex();
      _animateDragTo(0);
    });
  }

  void _animateDragTo(double target) {
    _returnTimer?.cancel();
    _returnFrom = _dragY.value;
    _returnTo = target;
    if ((_returnTo - _returnFrom).abs() < 0.5) {
      _dragY.value = _returnTo;
      return;
    }
    unawaited(_returnCtl.forward(from: 0).whenComplete(() {
      if (!mounted) {
        return;
      }
      _dragY.value = _returnTo;
    }));
  }

  void _syncLayoutIndex() {
    final int target = _clampIndex(widget.activeIndex, widget.lyrics.lines.length);
    if (target == _layoutIndex) {
      return;
    }
    _animateLayout = true;
    setState(() => _layoutIndex = target);
  }

  // ------------------------------------------------------------ 行高测量

  bool _needsMeasure(double width, double textScale) {
    return _measureWidth != width ||
        _measureTextScale != textScale ||
        !identical(_measureLyrics, widget.lyrics) ||
        _measureFontSize != widget.fontSize ||
        _measureLineHeight != widget.lineHeight ||
        _measureTranslationSize != widget.translationSize ||
        _measureTranslationGap != widget.translationGap ||
        _measureSubMode != widget.subMode ||
        _measureWordLyrics != widget.wordLyrics;
  }

  TextStyle get _mainTextStyle => TextStyle(
        fontSize: widget.fontSize,
        fontWeight: FontWeight.w700,
        height: widget.lineHeight,
        letterSpacing: 0.6,
      );

  void _recomputeHeights(double width, double textScale, TextScaler scaler) {
    final List<LyricLine> lines = widget.lyrics.lines;
    final List<double> plain =
        List<double>.filled(lines.length, widget.fontSize * widget.lineHeight);
    final List<double> wrap =
        List<double>.filled(lines.length, widget.fontSize * widget.lineHeight);
    final double available = width - _LyricMotion.horizontalPadding * 2;
    final double layoutWidth = available > 0 ? available : width;

    for (int i = 0; i < lines.length; i++) {
      final LyricLine line = lines[i];
      final double subHeight = _measureSub(line, layoutWidth, scaler);
      plain[i] = _measurePlain(line, layoutWidth, scaler) + subHeight;
      final List<WordUnit>? units = line.units;
      if (widget.wordLyrics && units != null && units.isNotEmpty) {
        wrap[i] = _measureWrap(units, line.instrumental, layoutWidth, scaler) +
            subHeight;
      } else {
        wrap[i] = plain[i];
      }
    }

    _plainHeights = plain;
    _wrapHeights = wrap;
    // 逐词 Wrap 里每个 word 是一个带 height 的 Text，行高 = 缩放后的字号 * 倍数。
    _rowHeight = scaler.scale(widget.fontSize) * widget.lineHeight;
    _measureWidth = width;
    _measureTextScale = textScale;
    _measureLyrics = widget.lyrics;
    _measureFontSize = widget.fontSize;
    _measureLineHeight = widget.lineHeight;
    _measureTranslationSize = widget.translationSize;
    _measureTranslationGap = widget.translationGap;
    _measureSubMode = widget.subMode;
    _measureWordLyrics = widget.wordLyrics;
  }

  String _subTextOf(LyricLine line) {
    if (widget.subMode == 'none') {
      return '';
    }
    return line.subText(widget.subMode == 'romaji') ?? '';
  }

  /// 副行高度（单行 + ellipsis，所以 maxLines: 1）。
  double _measureSub(LyricLine line, double maxWidth, TextScaler scaler) {
    final String sub = _subTextOf(line);
    if (sub.isEmpty) {
      return 0;
    }
    final TextPainter tp = TextPainter(
      text: TextSpan(
        text: sub,
        style: TextStyle(
          fontSize: widget.fontSize * widget.translationSize / 100.0,
          fontWeight: FontWeight.w500,
          height: 1.3,
        ),
      ),
      textDirection: TextDirection.ltr,
      textScaler: scaler,
      maxLines: 1,
    )..layout(maxWidth: maxWidth);
    final double height = tp.height;
    tp.dispose();
    return widget.translationGap + height;
  }

  /// 整段 Text 的高度（非当前行 / 关闭逐字歌词时的真实渲染形态）。
  double _measurePlain(LyricLine line, double maxWidth, TextScaler scaler) {
    final TextPainter tp = TextPainter(
      text: TextSpan(text: line.text, style: _mainTextStyle),
      textDirection: TextDirection.ltr,
      textScaler: scaler,
    )..layout(maxWidth: maxWidth);
    final double height = tp.height;
    tp.dispose();
    return height;
  }

  /// 逐词 Wrap 的高度：按词宽贪心累加行数（与 Flutter Wrap 的换行判定一致）。
  double _measureWrap(
    List<WordUnit> units,
    bool instrumental,
    double maxWidth,
    TextScaler scaler,
  ) {
    // 间奏三点在 Wrap 里各带 4px 左右 padding（桌面端 margin: 0 4px）。
    final double extra = instrumental ? 8 : 0;
    double dx = 0;
    int rows = 1;
    for (final WordUnit u in units) {
      final TextPainter tp = TextPainter(
        text: TextSpan(text: u.text, style: _mainTextStyle),
        textDirection: TextDirection.ltr,
        textScaler: scaler,
        maxLines: 1,
      )..layout();
      final double w = tp.width + extra;
      tp.dispose();
      if (dx > 0 && dx + w > maxWidth) {
        rows += 1;
        dx = 0;
      }
      dx += w;
    }
    return rows * scaler.scale(widget.fontSize) * widget.lineHeight;
  }

  /// 第 i 行**当前的**渲染高度：当前行用逐词形态，其余用整段形态。
  double _heightAt(int i) {
    final double fallback = _rowHeight > 0
        ? _rowHeight
        : widget.fontSize * widget.lineHeight;
    if (i < 0 || i >= _plainHeights.length) {
      return fallback;
    }
    final List<WordUnit>? units = widget.lyrics.lines[i].units;
    final bool wordLevel =
        widget.wordLyrics && units != null && units.isNotEmpty;
    if (wordLevel && i == widget.activeIndex) {
      return _wrapHeights[i];
    }
    return _plainHeights[i];
  }

  /// 复刻 getLayout(now, to)：从基准行累加到目标行的位移，再加停靠高度。
  double _offsetFor(int i, double rest) {
    final int now = _layoutIndex;
    double res = rest;
    if (i > now) {
      for (int k = now; k < i; k++) {
        res += _heightAt(k) + widget.lineGap;
      }
    } else {
      for (int k = now; k > i; k--) {
        res -= _heightAt(k - 1) + widget.lineGap;
      }
    }
    return res;
  }

  // ------------------------------------------------------------ 构建

  Widget _emptyState() {
    // 对齐桌面端 .empty-lyrics：48px 图标（再叠 0.5 透明度）+ 主文案 + 13px 提示行。
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.lyrics_rounded, size: 48, color: Color(0x40FFFFFF)),
          SizedBox(height: 12),
          Text(
            '暂无歌词',
            style: TextStyle(
              color: Color(0x80FFFFFF),
              fontSize: 15,
              fontWeight: FontWeight.w500,
            ),
          ),
          SizedBox(height: 8),
          Opacity(
            opacity: 0.7,
            child: Text(
              '可加载同名 .lrc 文件或内嵌歌词',
              textAlign: TextAlign.center,
              style: TextStyle(color: Color(0x80FFFFFF), fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final List<LyricLine> lines = widget.lyrics.lines;
    if (lines.isEmpty) {
      return _emptyState();
    }

    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final double width = constraints.maxWidth;
        final double height = constraints.maxHeight;
        final TextScaler scaler = MediaQuery.textScalerOf(context);
        // 用数值当缓存键：TextScaler 实例未必实现 ==，否则会每帧重测。
        final double textScale = scaler.scale(100.0);

        if (_needsMeasure(width, textScale)) {
          _recomputeHeights(width, textScale, scaler);
          // 宽度 / 字号变化会改变每行高度，桌面端此时也用 animate=0 立即就位。
          _animateLayout = false;
        }
        if (_measureHeight != height) {
          _measureHeight = height;
          // 旋转 / 键盘让容器高度变化：桌面端 ResizeObserver 一律 animate=0。
          _animateLayout = false;
        }

        final double rest = height / widget.offsetDivisor;
        final List<Widget> children = <Widget>[];
        for (int i = 0; i < lines.length; i++) {
          final bool active = i == widget.activeIndex;
          final int distance = (i - _layoutIndex).abs();
          int n = i - _layoutIndex + 1;
          if (n > _LyricMotion.staggerLimit) {
            n = 0;
          }
          final int delay = n > 0 ? n * _LyricMotion.staggerStepMs : 0;
          final bool blurred = widget.blur &&
              !active &&
              distance <= _LyricMotion.blurDistanceLimit;

          children.add(
            Positioned(
              key: ValueKey<int>(i),
              top: 0,
              left: 0,
              right: 0,
              child: _LyricLineItem(
                line: lines[i],
                active: active,
                targetY: _offsetFor(i, rest),
                delayMs: delay,
                animate: _animateLayout,
                opacity: active ? 1.0 : _LyricMotion.fadeFor(distance),
                animateOpacity: distance <= _LyricMotion.animatedFadeDistance,
                blurSigma: blurred ? distance.toDouble() : 0.0,
                fontSize: widget.fontSize,
                lineHeight: widget.lineHeight,
                translationSize: widget.translationSize,
                translationGap: widget.translationGap,
                subMode: widget.subMode,
                wordLyrics: widget.wordLyrics,
                position: widget.position,
                onTap: widget.onSeekLine == null
                    ? null
                    : () => widget.onSeekLine!(lines[i]),
              ),
            ),
          );
        }

        // 上下渐隐：桌面端 mask-image: linear-gradient(to bottom,
        // transparent 0%, black 22%, black 74%, transparent 100%)。
        // 遮罩与裁剪都挂在容器上（不参与拖动的 Transform），否则拖动时
        // 渐隐带会跟着内容一起移出视口。
        final Widget content = ValueListenableBuilder<double>(
          valueListenable: _dragY,
          child: Stack(children: children),
          builder: (BuildContext context, double dy, Widget? child) =>
              Transform.translate(offset: Offset(0, dy), child: child),
        );

        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onVerticalDragStart: _onDragStart,
          onVerticalDragUpdate: _onDragUpdate,
          onVerticalDragEnd: _onDragEnd,
          onVerticalDragCancel: _onDragCancel,
          child: ShaderMask(
            blendMode: BlendMode.dstIn,
            shaderCallback: (Rect rect) => const LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[
                Color(0x00000000),
                Color(0xFF000000),
                Color(0xFF000000),
                Color(0x00000000),
              ],
              stops: <double>[0.0, 0.22, 0.74, 1.0],
            ).createShader(rect),
            child: ClipRect(child: content),
          ),
        );
      },
    );
  }
}

/// 单行歌词：自己管自己的位移动画（级联 + 独立缓动），外加距离模糊 / 透明度
/// 与「成为当前行」时的一次入场弹簧。
class _LyricLineItem extends StatefulWidget {
  const _LyricLineItem({
    super.key,
    required this.line,
    required this.active,
    required this.targetY,
    required this.delayMs,
    required this.animate,
    required this.opacity,
    required this.animateOpacity,
    required this.blurSigma,
    required this.fontSize,
    required this.lineHeight,
    required this.translationSize,
    required this.translationGap,
    required this.subMode,
    required this.wordLyrics,
    required this.position,
    required this.onTap,
  });

  final LyricLine line;
  final bool active;
  final double targetY;
  final int delayMs;
  final bool animate;
  final double opacity;
  final bool animateOpacity;
  final double blurSigma;
  final double fontSize;
  final double lineHeight;
  final double translationSize;
  final double translationGap;
  final String subMode;
  final bool wordLyrics;
  final ValueListenable<double> position;
  final VoidCallback? onTap;

  @override
  State<_LyricLineItem> createState() => _LyricLineItemState();
}

class _LyricLineItemState extends State<_LyricLineItem>
    with SingleTickerProviderStateMixin {
  late final AnimationController _move;
  double _fromY = 0;
  double _toY = 0;
  Timer? _delayTimer;

  @override
  void initState() {
    super.initState();
    _move = AnimationController(
      vsync: this,
      duration: _LyricMotion.slideDuration,
    );
    _fromY = widget.targetY;
    _toY = widget.targetY;
    _move.value = 1;
  }

  @override
  void didUpdateWidget(covariant _LyricLineItem old) {
    super.didUpdateWidget(old);
    if (old.targetY != widget.targetY) {
      _retarget(widget.targetY, widget.animate, widget.delayMs);
    }
  }

  void _retarget(double target, bool animate, int delayMs) {
    _delayTimer?.cancel();
    if (!animate) {
      _move.stop();
      _fromY = target;
      _toY = target;
      _move.value = 1;
      return;
    }
    // 停在 value == 0 等延迟时 _move 并未 isAnimating，但此刻屏幕上显示的
    // 是 _fromY —— 所以起点一律取 _currentY（value == 1 时它恒等于 _toY）。
    _fromY = _currentY;
    _toY = target;
    if (delayMs <= 0) {
      _move.forward(from: 0);
    } else {
      // 先停在起点等延迟，否则会先跳到目标位置、延迟失效。
      _move.value = 0;
      _delayTimer = Timer(Duration(milliseconds: delayMs), () {
        if (mounted) {
          _move.forward();
        }
      });
    }
  }

  double get _currentY =>
      _fromY + (_toY - _fromY) * SM.amEaseLyric.transform(_move.value);

  @override
  void dispose() {
    _delayTimer?.cancel();
    _move.dispose();
    super.dispose();
  }

  // ------------------------------------------------------------ 着色

  static const Color _sungColor = SM.lyricSung;
  static const Color _unsungColor = SM.lyricUnsung;

  /// 非逐字行 / 非当前行的整行样式：桌面端 .lyric-item.active 是纯白，
  /// 其余 rgba(255,255,255,0.2)。桌面端没有「整行渐进填充」，别自作主张加。
  TextStyle _mainStyle({required bool active}) => TextStyle(
        color: active ? Colors.white : SM.lyricInactive,
        fontSize: widget.fontSize,
        fontWeight: FontWeight.w700,
        height: widget.lineHeight,
        letterSpacing: 0.6,
      );

  LinearGradient _fillGradient(double p) => LinearGradient(
        colors: const <Color>[
          _sungColor,
          _sungColor,
          _unsungColor,
          _unsungColor,
        ],
        stops: <double>[
          0.0,
          (p - _LyricMotion.wordSoftEdge).clamp(0.0, 1.0),
          (p + _LyricMotion.wordSoftEdge).clamp(0.0, 1.0),
          1.0,
        ],
      );

  double _wordProgress(WordUnit u, double t) {
    if (t >= u.end) {
      return 1;
    }
    if (t <= u.start) {
      return 0;
    }
    final double d = u.end - u.start;
    return d <= 0 ? 1 : ((t - u.start) / d).clamp(0.0, 1.0);
  }

  /// 逐字卡拉 OK。instrumental = 间奏三点：每个点单独 1.5 倍放大 + 左右 4px。
  Widget _wordLevel(List<WordUnit> units, double t, {required bool instrumental}) {
    final List<Widget> children = <Widget>[];
    for (final WordUnit u in units) {
      final double p = _wordProgress(u, t);
      final double lift = p >= 1 ? -2.0 : 0.0;

      Widget word = ShaderMask(
        blendMode: BlendMode.srcIn,
        shaderCallback: (Rect bounds) => _fillGradient(p).createShader(bounds),
        child: Text(
          u.text,
          style: TextStyle(
            color: Colors.white,
            fontSize: widget.fontSize,
            fontWeight: FontWeight.w700,
            height: widget.lineHeight,
            letterSpacing: 0.6,
          ),
        ),
      );
      if (instrumental) {
        word = Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Transform.scale(scale: 1.5, child: word),
        );
      }
      // 桌面端 .word.sung { transform: translateY(-2px) }，0.5s 弹簧过渡。
      word = TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: 0, end: lift),
        duration: _LyricMotion.wordLiftDuration,
        curve: SM.springSpatialFast,
        builder: (BuildContext context, double dy, Widget? inner) =>
            Transform.translate(offset: Offset(0, dy), child: inner),
        child: word,
      );
      children.add(word);
    }
    return Wrap(
      alignment: WrapAlignment.center,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: children,
    );
  }

  @override
  Widget build(BuildContext context) {
    final LyricLine line = widget.line;
    final String sub = widget.subMode == 'none'
        ? ''
        : (line.subText(widget.subMode == 'romaji') ?? '');
    final List<WordUnit>? units = line.units;
    final bool wordLevel = widget.wordLyrics && units != null && units.isNotEmpty;

    Widget main;
    if (widget.active && wordLevel) {
      // 桌面端只在当前行渲染 .word（其余行走整段文本），所以非当前行不建词子树。
      final List<WordUnit> activeUnits = units!;
      main = ValueListenableBuilder<double>(
        valueListenable: widget.position,
        builder: (BuildContext context, double t, Widget? _) =>
            _wordLevel(activeUnits, t, instrumental: line.instrumental),
      );
    } else {
      main = Text(
        line.text,
        textAlign: TextAlign.center,
        style: _mainStyle(active: widget.active),
      );
    }

    if (widget.active) {
      // 桌面端 .lyric-text.pop：只缩放主文本，副行不参与。
      main = TweenAnimationBuilder<double>(
        tween: Tween<double>(begin: 0.97, end: 1.0),
        duration: _LyricMotion.popDuration,
        curve: SM.springSpatialFast,
        builder: (BuildContext context, double scale, Widget? inner) =>
            Transform.scale(scale: scale, child: inner),
        child: main,
      );
    }

    final List<Widget> column = <Widget>[main];
    if (sub.isNotEmpty) {
      column.add(
        Padding(
          padding: EdgeInsets.only(top: widget.translationGap),
          // 桌面端 .lyric-translation { opacity: 0.72 }，颜色随行。
          child: Opacity(
            opacity: 0.72,
            child: Text(
              sub,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: widget.active ? Colors.white : SM.lyricInactive,
                fontSize: widget.fontSize * widget.translationSize / 100.0,
                fontWeight: FontWeight.w500,
                height: 1.3,
              ),
            ),
          ),
        ),
      );
    }

    Widget body = GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: widget.onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: _LyricMotion.horizontalPadding,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: column,
        ),
      ),
    );

    // 模糊包在内、透明度包在外：AnimatedOpacity 的位置与类型必须稳定，
    // 否则它会在 initState 直接采用新值、永远不补动画（桌面端 opacity 是
    // 在 0.7s transition 里的）。模糊的有无变化被关进 _BlurProxy 内部。
    body = _BlurProxy(sigma: widget.blurSigma, child: body);

    final double opacity = widget.opacity.clamp(0.0, 1.0);
    body = widget.animateOpacity
        ? AnimatedOpacity(
            opacity: opacity,
            duration: _LyricMotion.slideDuration,
            curve: SM.amEaseLyric,
            child: body,
          )
        : Opacity(opacity: opacity, child: body);

    return AnimatedBuilder(
      animation: _move,
      child: body,
      builder: (BuildContext context, Widget? inner) => Transform.translate(
        offset: Offset(0, _currentY),
        child: inner,
      ),
    );
  }
}

/// 模糊代理：把「有 / 无高斯模糊」这一对形态收在一个固定类型的 widget 里。
///
/// 不能直接写 if (sigma > 0) ImageFiltered(...) else child —— 那样被换掉的是上层
/// AnimatedOpacity 的 child 槽位类型，它的 State 随之重建，透明度过渡就废了。
/// 这里变化只发生在 _BlurProxy 内部。
class _BlurProxy extends StatelessWidget {
  const _BlurProxy({required this.sigma, required this.child});

  final double sigma;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    if (sigma <= 0.01) {
      return child;
    }
    // RepaintBoundary 在 ImageFiltered 外层：模糊结果缓存成一层，
    // 之后 0.7s 位移动画每帧只做图层平移，不重新过高斯。
    return RepaintBoundary(
      child: ImageFiltered(
        imageFilter: ui.ImageFilter.blur(
          sigmaX: sigma,
          sigmaY: sigma,
          tileMode: ui.TileMode.decal,
        ),
        child: child,
      ),
    );
  }
}
