import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';

/// WebView 的音频出口。
///
/// 架构：WebView 里的 Vue 播放器 store 仍然是队列、歌词、UI 的唯一真相，
/// Flutter 只负责**出声** —— 前端那个 `<audio>` 被换成虚拟元素（见
/// apps/desktop/src/mobile/audio-shim.ts），真实的解码与输出落在这里。
///
/// 为什么不把整套播放逻辑搬过来：桌面端的播放器语义（整队列 Fisher-Yates、
/// 单曲循环不消耗随机序、playNext 插到 currentIndex+1、逐字歌词的时间源）
/// 已经在前端跑通并经过验证，重写一遍等于把已知正确的行为再赌一次。
/// 换掉的只有输出端，收益是息屏后继续播、通知栏与锁屏有控制。
///
/// 这里刻意**不**持有队列或歌词状态：一旦两边都存一份，就会出现两个真相。
class WebAudioHost {
  WebAudioHost({required this.emit});

  /// 把事件回灌给 WebView（走 bridge 的 silvermoon:native 通道）。
  final Future<void> Function(Map<String, Object?> event) emit;

  final AudioPlayer _player = AudioPlayer();

  StreamSubscription<Duration?>? _durSub;
  StreamSubscription<PlayerState>? _stateSub;
  Timer? _tick;

  String _src = '';
  bool _wasPlaying = false;
  bool _disposed = false;

  /// 通知栏 / 锁屏用的元信息，由 main-mobile.ts 周期性上报的 player:state 填充。
  String _title = '';
  String _artist = '';
  String _cover = '';

  void _wire() {
    // timeupdate 只由下面那个 100ms 定时器产出。just_audio 的 positionStream
    // 大约 200ms 一次，两路一起发会让前端收到重复事件。
    _durSub = _player.durationStream.listen((Duration? d) {
      if (d == null) return;
      unawaited(emit(<String, Object?>{
        'type': 'loadedmetadata',
        'duration': d.inMilliseconds / 1000.0,
      }));
    });
    _stateSub = _player.playerStateStream.listen((PlayerState s) {
      if (s.processingState == ProcessingState.completed) {
        _wasPlaying = false;
        unawaited(emit(<String, Object?>{'type': 'ended'}));
        return;
      }
      if (s.playing == _wasPlaying) return;
      _wasPlaying = s.playing;
      unawaited(emit(<String, Object?>{'type': s.playing ? 'play' : 'pause'}));
    });
    // 前端靠 timeupdate 驱动歌词高亮与进度条。
    // 浏览器原生是 4Hz 左右，这里给 10Hz —— 逐字歌词的填充要跟得上。
    _tick = Timer.periodic(const Duration(milliseconds: 100), (Timer t) {
      if (!_player.playing) return;
      unawaited(emit(<String, Object?>{
        'type': 'timeupdate',
        'currentTime': _player.position.inMilliseconds / 1000.0,
      }));
    });
  }

  /// 由 player:state 事件填充，只用于 MediaItem 的展示。
  void updateMeta({String? title, String? artist, String? cover}) {
    _title = title ?? _title;
    _artist = artist ?? _artist;
    _cover = cover ?? _cover;
  }

  /// 收到一条来自 WebView 的原始消息；不是音频消息就返回 false，交回 bridge。
  bool handleRaw(String raw) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return false;
    }
    if ((msg['kind'] ?? '').toString() != 'audio') return false;
    unawaited(_handle(msg));
    return true;
  }

  Future<void> _handle(Map<String, dynamic> msg) async {
    final String op = (msg['op'] ?? '').toString();
    try {
      switch (op) {
        case 'load':
          await _load((msg['src'] ?? '').toString());
          break;
        case 'play':
          final String src = (msg['src'] ?? '').toString();
          if (src.isNotEmpty && src != _src) await _load(src);
          await _player.play();
          break;
        case 'pause':
          await _player.pause();
          break;
        case 'seek':
          final double t = (msg['time'] as num?)?.toDouble() ?? 0;
          await _player.seek(Duration(milliseconds: (t * 1000).round()));
          unawaited(emit(<String, Object?>{'type': 'timeupdate', 'currentTime': t}));
          break;
        case 'volume':
          await _player.setVolume((msg['value'] as num?)?.toDouble() ?? 1);
          break;
        case 'rate':
          await _player.setSpeed((msg['value'] as num?)?.toDouble() ?? 1);
          break;
        case 'stop':
          await _player.stop();
          break;
      }
    } catch (e) {
      debugPrint('音频出口执行失败 $op: $e');
      await emit(<String, Object?>{'type': 'error', 'message': '$e'});
    }
  }

  /// 把 loopback 的 /asset/<路径> 还原成文件路径直接播，
  /// 免得 Flutter 再走一遍自己刚起的 HTTP 服务把同一个文件读回来。
  Uri _uriFor(String src) {
    final Uri u = Uri.tryParse(src) ?? Uri();
    if (u.host == '127.0.0.1' && u.path.startsWith('/asset/')) {
      final String p = Uri.decodeComponent(u.path.substring('/asset/'.length));
      if (p.isNotEmpty) return Uri.file(p);
    }
    return u;
  }

  Future<void> _load(String src) async {
    if (src.isEmpty) {
      _src = '';
      await _player.stop();
      return;
    }
    // 音效开关会先把 src 清掉再设回来触发重载。源没变就别真的重载，
    // 只补一次 loadedmetadata，让前端的恢复进度逻辑能跑完。
    if (src == _src && _player.duration != null) {
      await emit(<String, Object?>{
        'type': 'loadedmetadata',
        'duration': _player.duration!.inMilliseconds / 1000.0,
      });
      return;
    }
    _src = src;
    final Future<void> pending = _player.setAudioSource<Duration>(
      AudioSource.uri(
        _uriFor(src),
        tag: MediaItem(
          id: src,
          title: _title.isEmpty ? 'SilverMoon' : _title,
          artist: _artist.isEmpty ? null : _artist,
          artUri: _cover.startsWith('http') ? Uri.tryParse(_cover) : null,
        ),
      ),
    );
    await pending;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _tick?.cancel();
    await _durSub?.cancel();
    await _stateSub?.cancel();
    await _player.dispose();
  }
}