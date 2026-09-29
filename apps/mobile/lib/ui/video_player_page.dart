import 'dart:io';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../services/media_service.dart';

/// 全屏视频播放（基础版：播放/暂停、进度、倍速）。
class VideoPlayerPage extends StatefulWidget {
  const VideoPlayerPage({super.key, required this.item});

  final MediaItem item;

  @override
  State<VideoPlayerPage> createState() => _VideoPlayerPageState();
}

class _VideoPlayerPageState extends State<VideoPlayerPage> {
  VideoPlayerController? _ctl;
  bool _ready = false;
  String? _error;
  bool _chrome = true;
  Duration _pos = Duration.zero;
  Duration _dur = Duration.zero;
  double _speed = 1;

  @override
  void initState() {
    super.initState();
    _open();
  }

  Future<void> _open() async {
    final VideoPlayerController c =
        VideoPlayerController.file(File(widget.item.path));
    _ctl = c;
    try {
      await c.initialize();
      await c.setLooping(false);
      c.addListener(_tick);
      if (!mounted) return;
      setState(() {
        _ready = true;
        _dur = c.value.duration;
      });
      await c.play();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '无法播放：$e');
    }
  }

  void _tick() {
    final VideoPlayerController? c = _ctl;
    if (c == null || !mounted) return;
    final VideoPlayerValue v = c.value;
    final Duration p = v.position;
    // 只在整秒变化时刷新，避免每帧 setState
    if (p.inSeconds != _pos.inSeconds ||
        v.duration != _dur ||
        v.isPlaying != _ready) {
      setState(() {
        _pos = p;
        _dur = v.duration;
      });
    }
  }

  @override
  void dispose() {
    _ctl?.removeListener(_tick);
    _ctl?.dispose();
    super.dispose();
  }

  String _fmt(Duration d) {
    final int h = d.inHours;
    final int m = d.inMinutes.remainder(60);
    final int s = d.inSeconds.remainder(60);
    final String mm = m.toString().padLeft(2, '0');
    final String ss = s.toString().padLeft(2, '0');
    return h > 0 ? '$h:$mm:$ss' : '$m:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final VideoPlayerController? c = _ctl;
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: <Widget>[
          Center(
            child: _error != null
                ? Padding(
                    padding: const EdgeInsets.all(32),
                    child: Text(
                      _error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white70),
                    ),
                  )
                : (_ready && c != null
                    ? AspectRatio(
                        aspectRatio: c.value.aspectRatio,
                        child: VideoPlayer(c),
                      )
                    : const CircularProgressIndicator()),
          ),
          if (_ready)
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: () => setState(() => _chrome = !_chrome),
                child: AnimatedOpacity(
                  opacity: _chrome ? 1 : 0,
                  duration: const Duration(milliseconds: 180),
                  child: Container(
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: <Color>[
                          Color(0x99000000),
                          Color(0x00000000),
                          Color(0x00000000),
                          Color(0xB3000000),
                        ],
                        stops: <double>[0, 0.25, 0.7, 1],
                      ),
                    ),
                    child: Column(
                      children: <Widget>[
                        _topBar(),
                        const Spacer(),
                        _bottomBar(c!),
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

  Widget _topBar() {
    return Padding(
      padding: EdgeInsets.only(
        top: MediaQuery.of(context).padding.top + 4,
        left: 4,
        right: 12,
      ),
      child: Row(
        children: <Widget>[
          IconButton(
            icon: const Icon(Icons.arrow_back_rounded),
            color: Colors.white,
            onPressed: () => Navigator.of(context).maybePop(),
          ),
          Expanded(
            child: Text(
              widget.item.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Colors.white, fontSize: 15),
            ),
          ),
        ],
      ),
    );
  }

  Widget _bottomBar(VideoPlayerController c) {
    final double max = _dur.inMilliseconds.toDouble().clamp(1, double.infinity);
    final double value =
        _pos.inMilliseconds.toDouble().clamp(0, max).toDouble();
    return Padding(
      padding: EdgeInsets.only(
        left: 12,
        right: 12,
        bottom: MediaQuery.of(context).padding.bottom + 10,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(_fmt(_pos),
                  style: const TextStyle(color: Colors.white70, fontSize: 12)),
              Expanded(
                child: Slider(
                  value: value,
                  max: max,
                  onChanged: (double v) {
                    c.seekTo(Duration(milliseconds: v.round()));
                    setState(() =>
                        _pos = Duration(milliseconds: v.round()));
                  },
                ),
              ),
              Text(_fmt(_dur),
                  style: const TextStyle(color: Colors.white70, fontSize: 12)),
            ],
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              IconButton(
                iconSize: 44,
                icon: Icon(
                  c.value.isPlaying
                      ? Icons.pause_circle_filled_rounded
                      : Icons.play_circle_fill_rounded,
                  color: Colors.white,
                ),
                onPressed: () {
                  setState(() {
                    if (c.value.isPlaying) {
                      c.pause();
                    } else {
                      c.play();
                    }
                  });
                },
              ),
              const SizedBox(width: 12),
              TextButton(
                onPressed: () {
                  const List<double> speeds = <double>[1, 1.25, 1.5, 2, 0.5];
                  final int i = speeds.indexOf(_speed);
                  final double next = speeds[(i + 1) % speeds.length];
                  c.setPlaybackSpeed(next);
                  setState(() => _speed = next);
                },
                child: Text('${_speed}x',
                    style: const TextStyle(color: Colors.white)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
