import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart' hide RepeatMode;
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../models/lyric.dart';
import '../models/play_mode.dart';
import '../models/track.dart';
import '../services/palette_service.dart';
import '../services/player_service.dart';
import '../state/settings_controller.dart';
import '../theme/design_tokens.dart';
import 'lyrics_view.dart';
import 'sheets.dart';
import 'widgets.dart';

/// 全屏播放器。整体保持桌面端的「纯黑 + 动态背景 + 白色歌词」语言。
class NowPlayingPage extends StatefulWidget {
  const NowPlayingPage({super.key});

  @override
  State<NowPlayingPage> createState() => _NowPlayingPageState();
}

class _NowPlayingPageState extends State<NowPlayingPage> {
  late final PlayerService _player;

  final ValueNotifier<double> _posSec = ValueNotifier<double>(0);
  final ValueNotifier<Duration> _posDur = ValueNotifier<Duration>(Duration.zero);
  final ValueNotifier<bool> _playing = ValueNotifier<bool>(false);

  int _activeIndex = -1;
  String? _trackId;
  bool _showLyrics = true;

  Color _seed = const Color(0xFF1A5C9E);
  String? _seedTrackId;

  @override
  void initState() {
    super.initState();
    _player = context.read<PlayerService>();
    _player.addListener(_onPlayer);
    _posSec.value = _player.position.inMilliseconds / 1000.0;
    _posDur.value = _player.position;
    _playing.value = _player.playing;
    _activeIndex = _player.currentLyricIndex;
    _trackId = _player.currentTrack?.id;
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadPalette());
  }

  @override
  void dispose() {
    _player.removeListener(_onPlayer);
    _posSec.dispose();
    _posDur.dispose();
    _playing.dispose();
    super.dispose();
  }

  void _onPlayer() {
    _posSec.value = _player.position.inMilliseconds / 1000.0;
    _posDur.value = _player.position;
    _playing.value = _player.playing;
    final int idx = _player.currentLyricIndex;
    final String? id = _player.currentTrack?.id;
    if (idx != _activeIndex || id != _trackId) {
      final bool trackChanged = id != _trackId;
      setState(() {
        _activeIndex = idx;
        _trackId = id;
      });
      if (trackChanged) {
        _loadPalette();
      }
    }
  }

  Future<void> _loadPalette() async {
    final Track? t = _player.currentTrack;
    if (t == null) return;
    if (_seedTrackId == t.id) return;
    _seedTrackId = t.id;
    final Color? cached = PaletteService.recall(t.id);
    if (cached != null) {
      if (mounted) setState(() => _seed = cached);
      return;
    }
    final String? url = t.coverUrl;
    if (url == null || url.trim().isEmpty) return;
    try {
      final http.Response r = await http.get(Uri.parse(url.trim()));
      if (r.statusCode >= 400) return;
      final Color? c = await PaletteService.seedFromBytes(r.bodyBytes);
      if (c == null) return;
      PaletteService.remember(t.id, c);
      if (!mounted || _seedTrackId != t.id) return;
      setState(() => _seed = c);
    } catch (_) {
      // 取色失败就用主题色
    }
  }

  @override
  Widget build(BuildContext context) {
    final SettingsController settings = context.watch<SettingsController>();
    final Track? track = _player.currentTrack;
    final Lyrics lyrics = _player.lyrics;
    final Duration? dur = _player.effectiveDuration;

    return Scaffold(
      backgroundColor: PlayerTokens.background,
      body: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          _FluidBackground(
            seed: _seed,
            mode: settings.playerBackground,
            coverUrl: track?.coverUrl,
          ),
          SafeArea(
            child: Column(
              children: <Widget>[
                _topBar(context, track),
                Expanded(child: _stage(settings, track, lyrics)),
                _progressRow(dur),
                _controls(),
                _bottomRow(settings),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _topBar(BuildContext context, Track? track) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 6, 6, 0),
      child: Row(
        children: <Widget>[
          IconButton(
            icon: const Icon(
              Icons.keyboard_arrow_down_rounded,
              color: PlayerTokens.foreground,
              size: 30,
            ),
            onPressed: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: Column(
              children: <Widget>[
                Text(
                  track?.displayTitle ?? '未在播放',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: PlayerTokens.foreground,
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  track?.displayArtist ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 12),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.playlist_play_rounded, color: PlayerTokens.foreground),
            onPressed: () => showQueueSheet(context),
          ),
        ],
      ),
    );
  }

  Widget _stage(SettingsController settings, Track? track, Lyrics lyrics) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => setState(() => _showLyrics = !_showLyrics),
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 320),
        switchInCurve: Curves.easeOutCubic,
        switchOutCurve: Curves.easeInCubic,
        child: _showLyrics
            ? KeyedSubtree(
                key: const ValueKey<String>('lyrics'),
                child: LyricsView(
                  lyrics: lyrics,
                  position: _posSec,
                  activeIndex: _activeIndex,
                  fontSize: settings.settings.lyricFontSize,
                  lineHeight: settings.settings.lyricLineHeight,
                  lineGap: settings.settings.lyricLineGap,
                  translationSize: settings.settings.lyricTranslationSize,
                  subMode: settings.settings.lyricSubMode,
                  wordLyrics: settings.settings.wordLyrics,
                  onSeekLine: (LyricLine l) => _player
                      .seek(Duration(milliseconds: (l.time * 1000).round())),
                ),
              )
            : KeyedSubtree(
                key: const ValueKey<String>('cover'),
                child: _coverView(track),
              ),
      ),
    );
  }

  Widget _coverView(Track? track) {
    final Size screen = MediaQuery.of(context).size;
    final double size = math.min(screen.width * 0.74, screen.height * 0.34);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(size * SM.playerCoverRatio),
            boxShadow: const <BoxShadow>[
              BoxShadow(color: Color(0x66000000), blurRadius: 42, offset: Offset(0, 16)),
            ],
          ),
          child: CoverArt(
            track: track,
            size: size,
            radius: size * SM.playerCoverRatio,
          ),
        ),
        const SizedBox(height: 30),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 36),
          child: Text(
            track?.displayTitle ?? '未在播放',
            textAlign: TextAlign.center,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: PlayerTokens.foreground,
              fontSize: 20,
              fontWeight: FontWeight.w700,
              height: 1.3,
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(
          track?.displayArtist ?? '',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 13.5),
        ),
        if (_player.error != null) ...<Widget>[
          const SizedBox(height: 14),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40),
            child: Text(
              _player.error!,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Color(0xFFFFB4AB), fontSize: 12.5),
            ),
          ),
        ],
      ],
    );
  }

  Widget _progressRow(Duration? dur) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 0),
      child: Column(
        children: <Widget>[
          ValueListenableBuilder<Duration>(
            valueListenable: _posDur,
            builder: (BuildContext c, Duration pos, Widget? _) => _ProgressSlider(
              position: pos,
              duration: dur,
              onSeek: (Duration d) => _player.seek(d),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(
              children: <Widget>[
                ValueListenableBuilder<Duration>(
                  valueListenable: _posDur,
                  builder: (BuildContext c, Duration pos, Widget? _) => Text(
                    formatDurationShort(pos),
                    style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 11.5),
                  ),
                ),
                const Spacer(),
                Text(
                  formatDurationShort(dur),
                  style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 11.5),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _controls() {
    final RepeatMode rm = _player.repeatMode;
    final IconData repeatIcon = rm == RepeatMode.one
        ? Icons.repeat_one_rounded
        : Icons.repeat_rounded;
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 6, 22, 0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: <Widget>[
          SmCircleButton(
            icon: Icons.shuffle_rounded,
            size: SM.playerSideButton,
            active: _player.shuffleEnabled,
            onTap: () => _player.toggleShuffle(),
          ),
          SmCircleButton(
            icon: Icons.skip_previous_rounded,
            size: 48,
            iconSize: 30,
            onTap: () => _player.previous(),
          ),
          ValueListenableBuilder<bool>(
            valueListenable: _playing,
            builder: (BuildContext c, bool playing, Widget? _) => SmCircleButton(
              icon: playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
              size: SM.playerMainButton,
              iconSize: 36,
              filled: true,
              onTap: () => _player.togglePlay(),
            ),
          ),
          SmCircleButton(
            icon: Icons.skip_next_rounded,
            size: 48,
            iconSize: 30,
            onTap: _player.hasNext ? () => _player.next() : null,
          ),
          SmCircleButton(
            icon: repeatIcon,
            size: SM.playerSideButton,
            active: rm != RepeatMode.off,
            onTap: () => _player.cycleRepeat(),
          ),
        ],
      ),
    );
  }

  Widget _bottomRow(SettingsController settings) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
      child: Column(
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.volume_up_rounded, color: Color(0x99FFFFFF), size: 18),
              Expanded(
                child: SliderTheme(
                  data: SliderTheme.of(context).copyWith(
                    trackHeight: 3,
                    activeTrackColor: const Color(0xCCFFFFFF),
                    inactiveTrackColor: const Color(0x33FFFFFF),
                    thumbColor: PlayerTokens.foreground,
                    thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                    overlayShape: const RoundSliderOverlayShape(overlayRadius: 12),
                  ),
                  child: Slider(
                    value: _player.volume.clamp(0.0, 1.0),
                    onChanged: (double v) {
                      _player.setVolume(v);
                      settings.setVolume(v);
                    },
                  ),
                ),
              ),
              Text(
                (_player.volume * 100).round().toString() + '%',
                style: const TextStyle(color: Color(0x99FFFFFF), fontSize: 11.5),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Row(
            children: <Widget>[
              _pill(
                label: _player.speed == 1
                    ? '倍速'
                    : _player.speed.toString() + 'x',
                onTap: () async {
                  final double v = await _player.cycleSpeed();
                  await settings.setPlaybackRate(v);
                },
              ),
              const Spacer(),
              _iconBtn(
                _showLyrics ? Icons.album_rounded : Icons.lyrics_rounded,
                () => setState(() => _showLyrics = !_showLyrics),
                tooltip: '封面 / 歌词',
              ),
              _iconBtn(
                Icons.graphic_eq_rounded,
                () => showEffectsSheet(context),
                tooltip: '音效',
              ),
              _iconBtn(
                Icons.queue_music_rounded,
                () => showQueueSheet(context),
                tooltip: '播放队列',
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _pill({required String label, required VoidCallback onTap}) {
    return Material(
      color: PlayerTokens.panelSurface,
      shape: const StadiumBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          child: Text(
            label,
            style: const TextStyle(
              color: PlayerTokens.foreground,
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }

  Widget _iconBtn(IconData icon, VoidCallback onTap, {String? tooltip}) {
    final Widget b = Material(
      color: PlayerTokens.panelSurface,
      shape: const CircleBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          width: 38,
          height: 38,
          child: Icon(icon, size: 19, color: PlayerTokens.foreground),
        ),
      ),
    );
    if (tooltip == null) return Padding(padding: const EdgeInsets.only(left: 8), child: b);
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Tooltip(message: tooltip, child: b),
    );
  }
}

/// 播放进度条：静止 6px，拖动时 12px（对应桌面端 hover 效果）
class _ProgressSlider extends StatefulWidget {
  const _ProgressSlider({
    required this.position,
    required this.duration,
    required this.onSeek,
  });

  final Duration position;
  final Duration? duration;
  final ValueChanged<Duration> onSeek;

  @override
  State<_ProgressSlider> createState() => _ProgressSliderState();
}

class _ProgressSliderState extends State<_ProgressSlider> {
  bool _dragging = false;
  double? _dragValue;

  @override
  Widget build(BuildContext context) {
    final int total = widget.duration?.inMilliseconds ?? 0;
    final double value = _dragValue ??
        (total <= 0
            ? 0.0
            : (widget.position.inMilliseconds / total).clamp(0.0, 1.0));
    return SliderTheme(
      data: SliderTheme.of(context).copyWith(
        trackHeight: _dragging ? SM.playerProgressHeightHover : SM.playerProgressHeight,
        activeTrackColor: PlayerTokens.foreground,
        inactiveTrackColor: const Color(0x33FFFFFF),
        thumbColor: PlayerTokens.foreground,
        thumbShape: RoundSliderThumbShape(enabledThumbRadius: _dragging ? 8 : 0.1),
        overlayShape: const RoundSliderOverlayShape(overlayRadius: 16),
        trackShape: const RoundedRectSliderTrackShape(),
      ),
      child: Slider(
        value: value,
        onChangeStart: (double v) => setState(() {
          _dragging = true;
          _dragValue = v;
        }),
        onChanged: (double v) => setState(() => _dragValue = v),
        onChangeEnd: (double v) {
          widget.onSeek(Duration(milliseconds: (total * v).round()));
          setState(() {
            _dragging = false;
            _dragValue = null;
          });
        },
      ),
    );
  }
}

/// 动态背景：三团缓慢游走的径向渐变（取自封面主色），可选封面模糊模式。
class _FluidBackground extends StatefulWidget {
  const _FluidBackground({
    required this.seed,
    required this.mode,
    this.coverUrl,
  });

  final Color seed;
  final PlayerBackground mode;
  final String? coverUrl;

  @override
  State<_FluidBackground> createState() => _FluidBackgroundState();
}

class _FluidBackgroundState extends State<_FluidBackground>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctl = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 24),
  )..repeat();

  @override
  void dispose() {
    _ctl.dispose();
    super.dispose();
  }

  List<Color> _palette() {
    final HSVColor base = HSVColor.fromColor(widget.seed);
    final bool intense = widget.mode == PlayerBackground.amll;
    return <Color>[
      base.withSaturation((base.saturation * (intense ? 1.15 : 0.95)).clamp(0.0, 1.0))
          .withValue((base.value * (intense ? 0.95 : 0.8)).clamp(0.0, 1.0))
          .toColor(),
      base
          .withHue((base.hue + 42) % 360)
          .withSaturation((base.saturation * 0.9).clamp(0.0, 1.0))
          .withValue((base.value * 0.72).clamp(0.0, 1.0))
          .toColor(),
      base
          .withHue((base.hue + 300) % 360)
          .withSaturation((base.saturation * 1.05).clamp(0.0, 1.0))
          .withValue((base.value * 0.62).clamp(0.0, 1.0))
          .toColor(),
    ];
  }

  @override
  Widget build(BuildContext context) {
    if (widget.mode == PlayerBackground.off) {
      return const ColoredBox(color: PlayerTokens.background);
    }
    final List<Color> colors = _palette();
    final String? cover = widget.coverUrl;
    return Stack(
      fit: StackFit.expand,
      children: <Widget>[
        const ColoredBox(color: Color(0xFF07070A)),
        if (widget.mode == PlayerBackground.image && cover != null && cover.trim().isNotEmpty)
          ImageFiltered(
            imageFilter: ui.ImageFilter.blur(sigmaX: 46, sigmaY: 46),
            child: Image.network(
              cover.trim(),
              fit: BoxFit.cover,
              errorBuilder: (BuildContext c, Object e, StackTrace? s) =>
                  const SizedBox.shrink(),
            ),
          )
        else
          AnimatedBuilder(
            animation: _ctl,
            builder: (BuildContext c, Widget? _) => CustomPaint(
              painter: _BlobPainter(t: _ctl.value, colors: colors),
            ),
          ),
        const DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: <Color>[
                Color(0x33000000),
                Color(0x8C000000),
                Color(0xE6000000),
              ],
              stops: <double>[0.0, 0.55, 1.0],
            ),
          ),
        ),
      ],
    );
  }
}

class _BlobPainter extends CustomPainter {
  _BlobPainter({required this.t, required this.colors});

  final double t;
  final List<Color> colors;

  @override
  void paint(Canvas canvas, Size size) {
    for (int i = 0; i < colors.length; i++) {
      final double phase = t * 2 * math.pi + i * 2.09;
      final double cx = size.width * (0.5 + 0.34 * math.sin(phase * 0.7 + i * 1.7));
      final double cy = size.height * (0.42 + 0.30 * math.cos(phase * 0.53 + i * 1.1));
      final double r = size.shortestSide * (0.62 + 0.14 * math.sin(phase * 0.9 + i));
      final Offset center = Offset(cx, cy);
      final Paint p = Paint()
        ..blendMode = BlendMode.plus
        ..shader = RadialGradient(
          colors: <Color>[
            colors[i].withValues(alpha: 0.9),
            colors[i].withValues(alpha: 0.0),
          ],
        ).createShader(Rect.fromCircle(center: center, radius: r));
      canvas.drawCircle(center, r, p);
    }
  }

  @override
  bool shouldRepaint(covariant _BlobPainter old) =>
      old.t != t || old.colors != colors;
}
